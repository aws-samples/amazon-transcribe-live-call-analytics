#!/usr/bin/env python3.9
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Call Event DynamoDB stream Lambda Processor
"""
import asyncio
import logging
from os import environ, getenv
from typing import TYPE_CHECKING, Dict, List, TypedDict, Union
from urllib.parse import urlparse

# third-party imports from Lambda layer
from aws_lambda_powertools import Logger, Metrics, Tracer
from aws_lambda_powertools.metrics import MetricUnit
from aws_lambda_powertools.utilities.data_classes import DynamoDBStreamEvent
from aws_lambda_powertools.utilities.typing import LambdaContext
import boto3
from botocore.config import Config as BotoCoreConfig
from gql.client import Client
from gql.transport.aiohttp import AIOHTTPTransport
from gql.transport.appsync_auth import AppSyncIAMAuthentication

# local imports
# pylint: disable=import-error
from dynamodb_stream_event import DynamoDBDeserializedStreamEvent
from mapping import is_call_event_record
from call_event_handler import CallEventHandler
from tumbling_window_state import CallState, CallStateManager

# pylint: enable=import-error

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import DynamoDBServiceResource, Table as DynamoDbTable
    from mypy_boto3_comprehend.client import ComprehendClient
    from boto3 import Session as Boto3Session
else:
    Boto3Session = object
    ComprehendClient = object
    DynamoDBServiceResource = object
    DynamoDbTable = object

LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")
TRACER = Tracer()
METRICS = Metrics(
    namespace=getenv("POWERTOOLS_METRICS_NAMESPACE", "CallAnalytics"),
    service=getenv("POWERTOOLS_SERVICE_NAME", "CallEventStreamProcessor"),
)

APPSYNC_GRAPHQL_URL = environ["APPSYNC_GRAPHQL_URL"]
BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)
IS_SENTIMENT_ANALYSIS_ENABLED = getenv("IS_SENTIMENT_ANALYSIS_ENABLED", "true").lower() == "true"
if IS_SENTIMENT_ANALYSIS_ENABLED:
    COMPREHEND_CLIENT: ComprehendClient = BOTO3_SESSION.client("comprehend", config=CLIENT_CONFIG)
    COMPREHEND_LANGUAGE_CODE = getenv("COMPREHEND_LANGUAGE_CODE", "en")

EVENT_SOURCING_TABLE_NAME = environ["EVENT_SOURCING_TABLE_NAME"]
DYNAMODB_RESOURCE: DynamoDBServiceResource = BOTO3_SESSION.resource(
    "dynamodb",
    config=CLIENT_CONFIG,
)
EVENT_SOURCING_TABLE: DynamoDbTable = DYNAMODB_RESOURCE.Table(EVENT_SOURCING_TABLE_NAME)

EVENT_LOOP = asyncio.get_event_loop()


class EventHandlerResult(TypedDict):
    """Event Handler Result Type"""

    results: List[Union[Dict, Exception]]
    state: CallState
    event_error_count: float
    event_insert_count: float


async def handle_event(event: DynamoDBStreamEvent) -> EventHandlerResult:
    """Handles Call Events

    Loops through the DynamoDB stream records and handles asynchronous Call
    state mutations.

    Manages the Lambda Tumbling Window state to keep track of Call aggregations

    :param event: Lambda event
    """
    # pylint: disable=too-many-locals
    stream_deserialized_event = DynamoDBDeserializedStreamEvent(event)
    results: List[Union[Dict, Exception]] = []

    appsync_host = str(urlparse(APPSYNC_GRAPHQL_URL).netloc)
    appsync_auth = AppSyncIAMAuthentication(host=appsync_host)
    appsync_transport = AIOHTTPTransport(url=APPSYNC_GRAPHQL_URL, auth=appsync_auth)
    appsync_client = Client(transport=appsync_transport, fetch_schema_from_transport=True)
    async with appsync_client as appsync_session:
        call_event_handler_args = dict(
            appsync_session=appsync_session,
            metrics=METRICS,
            is_sentiment_analysis_enabled=IS_SENTIMENT_ANALYSIS_ENABLED,
        )
        if IS_SENTIMENT_ANALYSIS_ENABLED:
            call_event_handler_args["comprehend_client"] = COMPREHEND_CLIENT
            call_event_handler_args["comprehend_language"] = COMPREHEND_LANGUAGE_CODE

        call_event_handler = CallEventHandler(**call_event_handler_args)
        tasks = []
        for record in stream_deserialized_event.records:
            if not is_call_event_record(record):
                LOGGER.debug("not a call event record - skipping - keys: %s", record.dynamodb.keys)
                continue

            tasks.append(call_event_handler.handle(record=record))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        event_error_count = 0.0
        event_insert_count = 0.0
        state = {}
        async with CallStateManager(
            event=event,
            dynamodb_table=EVENT_SOURCING_TABLE,
            appsync_session=appsync_session,
        ) as call_state_manager:
            for result in results:
                if isinstance(result, Exception):
                    event_error_count = event_error_count + 1
                    LOGGER.error("call event exception: %s", result)
                else:
                    event_insert_count = event_insert_count + 1
                    if LOGGER.isEnabledFor(logging.DEBUG):
                        result_extra = result if isinstance(result, dict) else {}
                        LOGGER.debug("call event result", extra=result_extra)

                    updated_state = call_state_manager.update_state(input_item=result)
                    LOGGER.debug("updated state", extra=dict(updated_state=updated_state))

            state = call_state_manager.state

        if call_state_manager.has_error:
            event_error_count = event_error_count + 1

    return EventHandlerResult(
        {
            "results": results,
            "state": state,
            "event_error_count": event_error_count,
            "event_insert_count": event_insert_count,
        }
    )


@METRICS.log_metrics  # type: ignore
@TRACER.capture_lambda_handler
@LOGGER.inject_lambda_context
def handler(event: DynamoDBStreamEvent, context: LambdaContext):
    # pylint: disable=unused-argument
    """Lambda handler

    Processes Call events from the DynamoDB stream of the Event Sourcing table
    It manages the mutation of Call state/metadata including transcript and
    sentiment derived from the Call events.
    """
    LOGGER.debug("lambda event", extra={"event": event})
    LOGGER.info("GraphQL endpoint: [%s]", APPSYNC_GRAPHQL_URL)
    LOGGER.info("sentiment analysis enabled: [%s]", IS_SENTIMENT_ANALYSIS_ENABLED)

    record_count = len(event.get("Records", []))  # type: ignore
    METRICS.add_metric(
        name="EventBatchCount",
        unit=MetricUnit.Count,
        value=record_count,
    )
    event_result = EVENT_LOOP.run_until_complete(handle_event(event=event))

    METRICS.add_metric(
        name="EventInsertErrorCount",
        unit=MetricUnit.Count,
        value=event_result.get("event_error_count", 0.0),
    )
    METRICS.add_metric(
        name="EventInsertCount",
        unit=MetricUnit.Count,
        value=event_result.get("event_insert_count", 0.0),
    )

    # Lambda tumbling window state
    incoming_state = event.get("state", {})  # type: ignore
    outgoing_state = event_result.get("state", incoming_state)

    LOGGER.debug("state", extra=dict(incoming_state=incoming_state, outgoing_state=outgoing_state))
    return {"state": outgoing_state}
