# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Call State Manager"""
from datetime import datetime, timedelta, timezone
from statistics import fmean
import traceback
from typing import TYPE_CHECKING, Any, Dict, Final, List, Set

# imports from Lambda layer
# pylint: disable=import-error
# third party dependencies
from aws_lambda_powertools import Logger
from gql.client import Client as GqlClient
from gql.dsl import DSLMutation, DSLSchema, dsl_gql
from graphql.language.printer import print_ast

# shared modules
from appsync_utils import execute_gql_query_with_retries
from tumbling_window_state import StateManager
from graphql_helpers import call_fields

# pylint: enable=import-error

from .call_state_model import (
    CallState,
    ChannelType,
    SentimentByPeriodEntry,
    SentimentEntry,
    StatePerCallId,
    StatePerChannel,
)


if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table as DynamoDbTable
else:
    DynamoDbTable = object

LOGGER = Logger(child=True, location="%(filename)s:%(lineno)d - %(funcName)s()")


class TranscriptStateManager(StateManager):
    """Transcript State Manager

    Manages call state aggregations in the Lambda tumbling window and sends
    AppSync mutations on changes to the aggregated state
    """

    DEFAULT_MAX_INACTIVITY_IN_SECS: Final[int] = 1200

    def __init__(
        self,
        event: Dict[str, Any],
        dynamodb_table: DynamoDbTable,
        appsync_client: GqlClient,
        max_inactivity_in_secs: int = DEFAULT_MAX_INACTIVITY_IN_SECS,
        **kwargs,
    ) -> None:
        """
        Creates a Python context manager that is used to keep call aggregations
        using the Lambda tumbling window state.

        Context manager sends GraphQL mutations on exit to update call
        aggregations

        :param event: Lambda event
        :param dynamodb_table: boto3 DynamoDb Table resource
        :param appsync_client: gql Client used to send AppSync queries
        :param max_inactivity_in_secs: Used to expire items from state that have
            not being updated within this time window. Defaults to 1200
            (20 mins)
        """
        self._has_error = False
        super().__init__(event=event, dynamodb_table=dynamodb_table, **kwargs)

        # override empty dict state and default from super
        self._state: CallState = self._state or CallState({"StatePerCallId": {}})

        self._appsync_client = appsync_client
        self._max_inactivity_in_secs = max_inactivity_in_secs

        # introspection schema from AppSync endpoint
        if not self._appsync_client.schema:
            raise RuntimeError("GraphQL schema not found")
        self._ds = DSLSchema(self._appsync_client.schema)

        # updated call ids should be added to this set to iterate over changes
        # when the context manager exits
        self._changed_call_ids: Set[str] = set()

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if exc_type or exc_val or exc_tb:
            LOGGER.error(
                "call state error: %s, %s, %s",
                exc_type,
                exc_val,
                traceback.format_tb(exc_tb),
            )
            self._has_error = True

        try:
            self._update_state_aggregations()
            await self._send_gql_updates()
            self._prune_state()
        except Exception as exception:  # pylint: disable=broad-except
            self._has_error = True
            LOGGER.exception("call state exit exception: %s", exception)

        await super().__aexit__(exc_type, exc_val, exc_tb)

        # swallows exceptions
        return True

    @staticmethod
    def _get_sentiment_per_quarter(
        sentiment_list: List[SentimentEntry],
    ) -> List[SentimentByPeriodEntry]:
        sorted_sentiment = sorted(sentiment_list, key=lambda i: i["BeginOffsetMillis"])
        min_begin_time: float = (
            min(
                sorted_sentiment,
                key=lambda i: i["BeginOffsetMillis"],
            ).get("BeginOffsetMillis", 0.0)
            if sorted_sentiment
            else 0.0
        )
        max_end_time: float = (
            max(sorted_sentiment, key=lambda i: i["EndOffsetMillis"]).get("EndOffsetMillis", 0.0)
            if sorted_sentiment
            else 0.0
        )
        time_range: float = max_end_time - min_begin_time
        time_ranges = (
            (
                max((min_begin_time + time_range * i / 4), min_begin_time),
                min((min_begin_time + time_range * (i + 1) / 4), max_end_time),
            )
            for i in range(4)
        )
        quarters = (
            [
                s
                for s in sorted_sentiment
                if s["EndOffsetMillis"] > time_range[0] and s["EndOffsetMillis"] <= time_range[1]
            ]
            for time_range in time_ranges
        )
        sentiment_per_quarter = [
            SentimentByPeriodEntry(
                {
                    "Score": fmean((i["Score"] for i in quarter)) if quarter else 0,
                    "BeginOffsetMillis": (
                        min((i["BeginOffsetMillis"] for i in quarter)) if quarter else 0
                    ),
                    "EndOffsetMillis": (
                        max((i["EndOffsetMillis"] for i in quarter)) if quarter else 0
                    ),
                }
            )
            for quarter in quarters
        ]

        return sentiment_per_quarter

    def _update_state_aggregations(self) -> None:
        """Updates the state statistics/aggregations

        Maintains a subset of the Transcribe Call Analytics output:
        # XXX
        https://docs.aws.amazon.com/transcribe/latest/dg/call-analytics-output.html
        """
        for call_id in self._changed_call_ids:
            # call_state is used to update the state in place
            call_state = self._state["StatePerCallId"][call_id]
            call_state_per_channel = call_state["StatePerChannel"]

            for channel in call_state_per_channel.keys():
                sentiment_list = call_state_per_channel[channel].get("SentimentList", [])

                sentiment_scores = [i["Score"] for i in sentiment_list]
                sentiment_average = fmean(sentiment_scores) if sentiment_scores else 0

                sentiment_per_quarter = (
                    self._get_sentiment_per_quarter(sentiment_list) if sentiment_list else []
                )
                previous_sentiment = call_state.get("Sentiment", {})
                previous_overall_sentiment = previous_sentiment.get("OverallSentiment", {})
                previous_sentiment_by_quarter = previous_sentiment.get("SentimentByPeriod", {}).get(
                    "QUARTER", {}
                )

                # update sentiment state
                call_state["Sentiment"] = {
                    **previous_sentiment,  # type: ignore
                    "OverallSentiment": {
                        **previous_overall_sentiment,
                        channel: sentiment_average,
                    },
                    "SentimentByPeriod": {
                        "QUARTER": {
                            **previous_sentiment_by_quarter,
                            channel: sentiment_per_quarter,
                        },
                    },
                }

    async def _send_gql_updates(self) -> None:
        for call_id in self._changed_call_ids:
            call_state = self._state["StatePerCallId"][call_id]
            call_aggregation: Dict[str, object] = {
                "CallId": call_id,
            }

            total_duration = call_state.get("TotalConversationDurationMillis")
            if total_duration:
                call_aggregation["TotalConversationDurationMillis"] = total_duration
            sentiment = call_state.get("Sentiment")
            if sentiment:
                call_aggregation["Sentiment"] = sentiment

            try:
                async with self._appsync_client as appsync_session:
                    query = dsl_gql(
                        DSLMutation(
                            self._ds.Mutation.updateCallAggregation.args(
                                input=call_aggregation
                            ).select(*call_fields(self._ds))
                        )
                    )
                    result = await execute_gql_query_with_retries(
                        query=query,
                        client_session=appsync_session,
                        logger=LOGGER,
                    )
                    query_string = print_ast(query)
                    LOGGER.debug(
                        "transcript state mutation", extra=dict(query=query_string, result=result)
                    )
            except Exception as error:  # pylint: disable=broad-except
                LOGGER.error("error in call state graphql update: [%s]", error)
                LOGGER.exception("exception in call state graphql update")

    def _prune_state(self):
        inactivity_timestamp = (
            datetime.utcnow() - timedelta(seconds=self._max_inactivity_in_secs)
        ).isoformat()
        call_ids_inactive = {
            call_id
            for call_id, call_state in self._state.get("StatePerCallId", {}).items()
            if call_state.get("UpdatedAt", "") < inactivity_timestamp
        }
        if call_ids_inactive:
            # TODO  pylint: disable=fixme
            # may want to set the state to ENDED or FAILED
            LOGGER.warning("inactive call_ids: %s", call_ids_inactive)
        call_ids_ended = {
            call_id
            for call_id, call_state in self._state.get("StatePerCallId", {}).items()
            # only prune if the call wasn't updated in this batch to allow late changes to arrive
            if call_state.get("Status", "") == "ENDED" and call_id not in self._changed_call_ids
        }
        call_ids_to_delete = call_ids_inactive.union(call_ids_ended)
        if call_ids_to_delete:
            LOGGER.debug(
                "call ids to delete from state",
                extra=dict(call_ids_to_delete=list(call_ids_to_delete)),
            )
        for call_id in call_ids_to_delete:
            self._state["StatePerCallId"].pop(call_id)

    def _update_state_from_add_transcript_segment_result(
        self,
        mutation_result: Dict[str, Any],
    ) -> CallState:
        add_transcript_segment_result: Dict[str, Any] = mutation_result["addTranscriptSegment"]
        call_id: str = add_transcript_segment_result["CallId"]
        channel: ChannelType = add_transcript_segment_result["Channel"]

        previous_state_per_call_id = self._state.get("StatePerCallId", {})
        previous_call_id_state = previous_state_per_call_id.get(call_id, {})
        current_call_state = {"Status": "TRANSCRIBING", **add_transcript_segment_result}
        updated_call_id_state = self._update_call_state(previous_call_id_state, current_call_state)
        if updated_call_id_state != previous_call_id_state:
            self._changed_call_ids.add(call_id)

        end_time = add_transcript_segment_result["EndTime"] * 1000
        previous_duration = previous_call_id_state.get("TotalConversationDurationMillis", 0.0)
        if end_time > previous_duration:
            updated_call_id_state["TotalConversationDurationMillis"] = end_time
            self._changed_call_ids.add(call_id)

        previous_state_per_channel = updated_call_id_state.get(
            "StatePerChannel",
            {channel: {}},
        )
        previous_channel_state = previous_state_per_channel.get(channel, {})

        updated_channel_state = previous_channel_state
        if add_transcript_segment_result.get("SentimentWeighted"):
            sentiment_entry: SentimentEntry = {
                "Id": add_transcript_segment_result["SegmentId"],
                "BeginOffsetMillis": add_transcript_segment_result["StartTime"] * 1000,
                "EndOffsetMillis": add_transcript_segment_result["EndTime"] * 1000,
                "Sentiment": add_transcript_segment_result["Sentiment"],
                "Score": add_transcript_segment_result["SentimentWeighted"],
            }
            updated_channel_state = self._update_channel_state(
                previous_channel_state,
                sentiment_entry,
            )
            if updated_channel_state != previous_channel_state:
                self._changed_call_ids.add(call_id)
        self._state = {
            **self._state,  # type: ignore
            "StatePerCallId": {
                **previous_state_per_call_id,
                call_id: {
                    **updated_call_id_state,
                    "StatePerChannel": {
                        **previous_state_per_channel,
                        channel: updated_channel_state,
                    },
                },
            },
        }

        return self._state

    def _update_state_from_update_call_status_result(
        self,
        mutation_result: Dict[str, Any],
    ) -> CallState:
        update_call_status_result: Dict[str, Any] = mutation_result["updateCallStatus"]
        call_id: str = update_call_status_result["CallId"]

        previous_state_per_call_id = self._state.get("StatePerCallId", {})
        previous_call_id_state = previous_state_per_call_id.get(call_id, {})
        current_call_state = {"Status": "STARTED", **update_call_status_result}
        updated_call_id_state = self._update_call_state(previous_call_id_state, current_call_state)
        previous_state_per_channel = previous_call_id_state.get("StatePerChannel", {})

        if updated_call_id_state != previous_call_id_state:
            self._changed_call_ids.add(call_id)

        self._state = {
            **self._state,  # type: ignore
            "StatePerCallId": {
                **previous_state_per_call_id,
                call_id: {
                    **updated_call_id_state,
                    "StatePerChannel": previous_state_per_channel,
                },
            },
        }

        return self._state

    @staticmethod
    def _update_channel_state(
        previous_channel_state: StatePerChannel,
        sentiment_entry: SentimentEntry,
    ) -> StatePerChannel:
        LOGGER.debug(
            "update channel state",
            extra=dict(
                previous_channel_state=previous_channel_state,
                sentiment_entry=sentiment_entry,
            ),
        )
        previous_sentiment_list = previous_channel_state.get("SentimentList", [])

        # sort and deduplicate entries for comparison
        updated_sentiment_dedupe_dict = {
            i["Id"]: i for i in (*previous_sentiment_list, sentiment_entry)
        }
        updated_sentiment_list = sorted(
            updated_sentiment_dedupe_dict.values(),
            key=lambda i: i["BeginOffsetMillis"],
        )

        return {
            **previous_channel_state,  # type: ignore
            "SentimentList": updated_sentiment_list,
        }

    @staticmethod
    def _update_call_state(previous: StatePerCallId, current: Dict[str, Any]) -> StatePerCallId:
        """Updates call status and created/updated dates"""
        LOGGER.debug(
            "update call status - previous current",
            extra=dict(previous=previous, current=current),
        )
        now = datetime.now(timezone.utc).astimezone().isoformat()

        # XXX this logic seems to be wrong - createdat is always the same as updatedat
        created_at = previous.get("CreatedAt", now)

        # take the latest UpdatedAt
        current_updated_at = current.get("UpdatedAt", now)
        if not isinstance(current_updated_at, str):
            current_updated_at = now
        previous_updated_at = previous.get("UpdatedAt", "")
        if not isinstance(previous_updated_at, str):
            previous_updated_at = ""
        updated_at = (
            current_updated_at if current_updated_at >= previous_updated_at else previous_updated_at
        )

        call_state = current if current_updated_at >= previous_updated_at else previous
        current_status = current.get("Status", "STARTED")
        previous_status = previous.get("Status", "STARTED")
        # do not override an ENDED status
        status = (
            "ENDED"
            if "ENDED" in {current_status, previous_status}
            else call_state.get("Status", "STARTED")
        )

        updated_call_state: StatePerCallId = {
            **previous,  # type: ignore
            "CreatedAt": created_at,
            "UpdatedAt": updated_at,
            "Status": status,
        }

        LOGGER.debug("updated call state", extra=dict(updated_call_state=updated_call_state))

        return updated_call_state

    def update_state(self, input_item: Dict[str, Any]) -> CallState:
        """Updates the call state aggregations"""
        # update state from transcripts
        if input_item.get("addTranscriptSegment", {}):
            return self._update_state_from_add_transcript_segment_result(input_item)

        # XXX is this used here? probably should be but need to move signaling events to KDS
        if input_item.get("updateCallStatus", {}):
            return self._update_state_from_update_call_status_result(input_item)

        return self._state
