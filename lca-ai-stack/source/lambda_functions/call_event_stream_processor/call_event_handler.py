# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Call Event Handler"""
import asyncio
from datetime import datetime, timezone
from time import time
from typing import TYPE_CHECKING, Any, Dict, Optional

# third-party imports from Lambda layer
from aws_lambda_powertools.metrics import single_metric, MetricUnit
from aws_lambda_powertools import Logger, Metrics
import boto3
from gql.client import AsyncClientSession
from gql.transport.exceptions import TransportQueryError
from gql.dsl import DSLMutation, DSLSchema, dsl_gql  # type: ignore
from graphql.language.ast import DocumentNode
from graphql.language.printer import print_ast

# local imports
# pylint: disable=import-error
from mapping import (
    is_call_create,
    is_call_status_update,
    is_transcript_segment_add,
    is_s3_recording_add,
    CALL_EVENT_TYPE_TO_STATUS,
)
from dynamodb_stream_event import DynamoDBRecord
from sentiment import ComprehendWeightedSentiment
from appsync import execute_gql_query_with_retries
from graphql_helpers import call_fields, transcript_segment_fields

# pylint: enable=import-error


if TYPE_CHECKING:
    from mypy_boto3_comprehend.client import ComprehendClient
    from mypy_boto3_comprehend.type_defs import DetectSentimentResponseTypeDef
    from mypy_boto3_comprehend.literals import LanguageCodeType
else:
    ComprehendClient = object
    DetectSentimentResponseTypeDef = object
    LanguageCodeType = object

LOGGER = Logger(child=True, location="%(filename)s:%(lineno)d - %(funcName)s()")


class CallEventHandler:
    # pylint: disable=too-few-public-methods,too-many-instance-attributes
    """Handles Call Event Sourcing Events

    Manages mutations on the AppSync GraphQL API from DynamoDB call events.
    It uses the AppSync GraphQL endpoint to dynamically obtain the schema.
    It uses asynchronous (async/await) to concurrently execute mutation
    queries to minimize latency.
    """
    OK_RESPONSE = {"ok": True}

    DEFAULT_MAX_RETRIES = 3
    DEFAULT_MIN_SLEEP_TIME = 0.750

    # class cache of Comprehend detect_sentiment outputs based on hash of text.
    _sentiment_cache: Dict[int, DetectSentimentResponseTypeDef] = {}

    def __init__(
        self,
        appsync_session: AsyncClientSession,
        metrics: Metrics,
        comprehend_client: Optional[ComprehendClient] = None,
        comprehend_language: LanguageCodeType = "en",
        is_sentiment_analysis_enabled: bool = True,
        **kwargs,
    ) -> None:
        """
        :param appsync_session: gql Client Session used to send AppSync queries
        :param is_sentiment_analysis_enabled: Controls if Comprehend Sentiment
        analysis is enabled.
        :param comprehend_client: boto3 comprehend client
        :param comprehend_language: Language code used for Amazon Comprehend
        :param metrics: Lambda Power Tools Metrics logger

        kwargs:
        :param max_retries: Number of times to retry appsync GraphQL queries
            after the initial query fails. This helps with async issues where
            mutations may occur out of order (e.g. transcript segment before a
            event has been processed)
        :param min_sleep_time: Minimum time in seconds to sleep between retries
            of a GraphQL query error. Uses exponential backoff with base 2
        """
        # pylint: disable=too-many-arguments
        self._appsync_session = appsync_session
        self._metrics = metrics
        self._is_sentiment_analysis_enabled = is_sentiment_analysis_enabled
        if is_sentiment_analysis_enabled:
            self._comprehend_client = comprehend_client or boto3.client("comprehend")
            self._comprehend_language = comprehend_language
            self._comprehend_weighted_sentiment = ComprehendWeightedSentiment()

        # kwargs - less frequently used overrides
        self._max_retries: int = kwargs.get("max_retries", self.DEFAULT_MAX_RETRIES)
        self._min_sleep_time: float = kwargs.get(
            "min_sleep_time",
            self.DEFAULT_MIN_SLEEP_TIME,
        )

        # introspection schema from AppSync endpoint
        if not appsync_session.client.schema:
            raise RuntimeError("GraphQL schema not found")
        self._ds = DSLSchema(appsync_session.client.schema)

    async def handle(self, record: DynamoDBRecord) -> Dict:
        """Handles call events

        Takes a record from the DynamoDB stream of the event sourcing table.
        Handles newly created DynamoDB items that match the Call Event key
        prefix. Maps the Call Event to the matching call state mutation
        (e.g. create/update call, add transcript segment). Logs metrics for
        each call event.

        Returns the output of the GraphQL query

        :param record: Deserialized DynamoDB stream record
        """
        item = record.dynamodb.new_image
        LOGGER.debug("call event dynamodb item", extra={"item": item})
        if "CallId" in item:
            LOGGER.append_keys(callId=item["CallId"])

        result = {}

        if is_call_create(item):
            result = await self._execute_create_call_mutation(item)
            self._metrics.add_metric(
                name="AddCallEvent",
                unit=MetricUnit.Count,
                value=1,
            )

        if is_call_status_update(item):
            result = await self._execute_update_call_status_mutation(item)
            self._metrics.add_metric(
                name="UpdateCallEvent",
                unit=MetricUnit.Count,
                value=1,
            )

        if is_transcript_segment_add(item):
            result = await self._handle_add_transcript_segment_mutation(item)
            self._metrics.add_metric(
                name="AddTranscriptSegmentEvent",
                unit=MetricUnit.Count,
                value=1,
            )

        if is_s3_recording_add(item):
            result = await self._execute_add_s3_recording_mutation(item)
            self._metrics.add_metric(
                name="AddS3RecordingEvent",
                unit=MetricUnit.Count,
                value=1,
            )

        if not result:
            error_message = "unable to match event"
            raise TypeError(error_message)

        return result

    async def _detect_sentiment(self, text: str) -> DetectSentimentResponseTypeDef:
        text_hash = hash(text)
        if text_hash in self._sentiment_cache:
            LOGGER.debug("using sentiment cache on text: [%s]", text)
            return self._sentiment_cache[text_hash]

        LOGGER.debug("detect sentiment on text: [%s]", text)
        loop = asyncio.get_running_loop()
        sentiment_future = loop.run_in_executor(
            None,
            lambda: self._comprehend_client.detect_sentiment(
                Text=text,
                LanguageCode=self._comprehend_language,
            ),
        )
        results = await asyncio.gather(sentiment_future)
        result = results[0]
        self._sentiment_cache[text_hash] = result

        return result

    async def _execute_gql_query_with_retries(self, query: DocumentNode) -> Dict:
        query_string = print_ast(query)
        result = await execute_gql_query_with_retries(
            query=query,
            client_session=self._appsync_session,
            max_retries=self._max_retries,
            min_sleep_time=self._min_sleep_time,
            should_ignore_exception_fn=self._should_ignore_gql_exception,
            ignored_exception_response=self.OK_RESPONSE,
            logger=LOGGER,
        )

        LOGGER.debug("query result", extra=dict(query=query_string, result=result))

        return result

    @staticmethod
    def _should_ignore_gql_exception(exception: Exception) -> bool:
        if isinstance(exception, TransportQueryError) and hasattr(exception, "errors"):
            errors = exception.errors or []
            for error in errors:
                # two call channels have the same transaction/call id which causes
                # an expected exception
                if (
                    "createCall" in error.get("path", [])
                    and "item already exists" in error.get("message", "").lower()
                ):
                    return True

        return False

    async def _execute_create_call_mutation(self, item: Dict) -> Dict:
        query = dsl_gql(
            DSLMutation(
                self._ds.Mutation.createCall.args(input=item).select(
                    self._ds.CreateCallOutput.CallId
                )
            )
        )
        return await self._execute_gql_query_with_retries(query)

    async def _execute_update_call_status_mutation(self, item: Dict[str, Any]) -> Dict:
        status = CALL_EVENT_TYPE_TO_STATUS.get(item.get("EventType"))
        if not status:
            error_message = "unrecognized status from event type in update call"
            raise TypeError(error_message)
        if status == "STARTED":
            # STARTED status is set by createCall - skip update mutation
            return self.OK_RESPONSE

        query = dsl_gql(
            DSLMutation(
                self._ds.Mutation.updateCallStatus.args(input={**item, "Status": status}).select(
                    *call_fields(self._ds)
                )
            )
        )
        return await self._execute_gql_query_with_retries(query)

    async def _handle_add_transcript_segment_mutation(self, item: Dict) -> Dict:
        response = await self._execute_add_transcript_segment_mutation(item=item)

        # Send another mutation if the segment is final to add the sentiment (if enabled)
        # This sends two mutations but it is done to keep latency to the client low
        # so that the response doesn't have to wait until the sentiment is added
        if self._is_sentiment_analysis_enabled and not item.get("IsPartial", True):
            # reset CreatedAt to avoid colliding with previous item without sentiment
            sentiment_item = {
                **item,
                "CreatedAt": datetime.now(timezone.utc).astimezone().isoformat(),
            }
            response = await self._execute_add_transcript_segment_with_sentiment_mutation(
                item=sentiment_item,
            )

        return response

    async def _execute_add_transcript_segment_with_sentiment_mutation(self, item: Dict) -> Dict:
        response = {}
        sentiment: Dict[str, Any] = {}
        transcript: str = item.get("Transcript", "")
        try:
            start = time()
            sentiment_response = await self._detect_sentiment(text=transcript)
            end = time()
            LOGGER.debug("detect sentiment elapsed time in seconds: [%.6f]", end - start)

            sentiment = {
                k: v for k, v in sentiment_response.items() if k in ["Sentiment", "SentimentScore"]
            }
            LOGGER.debug("sentiment", extra=sentiment)
        except Exception as error:  # pylint: disable=broad-except
            LOGGER.exception("detect sentiment exception: %s", error)

        if sentiment:
            # only use positive and negative sentiment for consistency with the Post Call Analytics
            # solution
            if sentiment.get("Sentiment") in ["POSITIVE", "NEGATIVE"]:
                sentiment[
                    "SentimentWeighted"
                ] = self._comprehend_weighted_sentiment.get_weighted_sentiment_score(
                    sentiment_response=sentiment_response
                )
                sentiment_weighted = sentiment["SentimentWeighted"]
                self._metrics.add_metric(
                    name="SentimentWeighted",
                    unit=MetricUnit.Count,
                    value=sentiment_weighted,
                )

            sentiment_value = sentiment["Sentiment"]
            # add sentiment metric with dimension based on sentiment value
            with single_metric(name="Count", unit=MetricUnit.Count, value=1) as metric:
                metric.add_dimension(name="Sentiment", value=sentiment_value)

            response = await self._execute_add_transcript_segment_mutation(
                item=item,
                sentiment=sentiment,
            )

        return response

    async def _execute_add_transcript_segment_mutation(
        self,
        item: Dict,
        sentiment: Optional[Dict] = None,
    ) -> Dict:
        _sentiment = sentiment or {}
        transcript_segment = {
            **item,
            **_sentiment,
        }
        transcript_segment["Status"] = "TRANSCRIBING"
        query = dsl_gql(
            DSLMutation(
                self._ds.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                    *transcript_segment_fields(self._ds),
                )
            )
        )
        return await self._execute_gql_query_with_retries(query)

    async def _execute_add_s3_recording_mutation(self, item: Dict) -> Dict:
        recording_url = item.get("RecordingUrl")
        if not recording_url:
            error_message = "recording url doesn't exist in add s3 recording url event"
            raise TypeError(error_message)
        query = dsl_gql(
            DSLMutation(
                self._ds.Mutation.updateRecordingUrl.args(
                    input={**item, "RecordingUrl": recording_url}
                ).select(*call_fields(self._ds))
            )
        )
        return await self._execute_gql_query_with_retries(query)
