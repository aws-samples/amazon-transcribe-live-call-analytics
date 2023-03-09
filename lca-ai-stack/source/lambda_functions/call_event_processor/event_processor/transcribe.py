# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Transcribe API Mutation Processor
"""
import asyncio
from datetime import datetime
from statistics import fmean
from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional, TypedDict
import uuid
import json

# third-party imports from Lambda layer
import boto3
from botocore.config import Config as BotoCoreConfig
from aws_lambda_powertools import Logger
from gql.client import AsyncClientSession as AppsyncAsyncClientSession
from gql.dsl import DSLMutation, DSLSchema, dsl_gql, DSLQuery
from graphql.language.printer import print_ast

# custom utils/helpers imports from Lambda layer
# pylint: disable=import-error
from appsync_utils import execute_gql_query_with_retries
from graphql_helpers import (
    call_fields,
    transcript_segment_fields,
    transcript_segment_sentiment_fields,
)
from lex_utils import recognize_text_lex
from sns_utils import publish_sns
from lambda_utils import invoke_lambda
from eventprocessor_utils import (
    normalize_transcript_segment,
    get_ttl,
    transform_segment_to_add_sentiment,
    transform_segment_to_issues_agent_assist
)
# pylint: enable=import-error
if TYPE_CHECKING:
    from mypy_boto3_lexv2_runtime.type_defs import RecognizeTextResponseTypeDef
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
    from mypy_boto3_lambda.client import LambdaClient
    from mypy_boto3_lambda.type_defs import InvocationResponseTypeDef
    from mypy_boto3_sns.client import SNSClient
    from mypy_boto3_ssm.client import SSMClient
    from boto3 import Session as Boto3Session
else:
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object
    LambdaClient = object
    InvocationResponseTypeDef = object
    Boto3Session = object
    SNSClient = object
    SSMClient = object

SNS_TOPIC_ARN = getenv("SNS_TOPIC_ARN", "")

IS_SENTIMENT_ANALYSIS_ENABLED = getenv("IS_SENTIMENT_ANALYSIS_ENABLED", "true").lower() == "true"

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)
TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN = getenv("TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN", "")
ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN = getenv("ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN", "")
IS_TRANSCRIPT_SUMMARY_ENABLED = getenv("IS_TRANSCRIPT_SUMMARY_ENABLED", "false").lower() == "true"

TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY = getenv(
    "TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY", "true").lower() == "true"
if TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN or ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN:
    LAMBDA_HOOK_CLIENT: LambdaClient = BOTO3_SESSION.client("lambda", config=CLIENT_CONFIG)

IS_LEX_AGENT_ASSIST_ENABLED = False
LEXV2_CLIENT: Optional[LexRuntimeV2Client] = None
LEX_BOT_ID: str
LEX_BOT_ALIAS_ID: str
LEX_BOT_LOCALE_ID: str

IS_LAMBDA_AGENT_ASSIST_ENABLED = False
LAMBDA_CLIENT: Optional[LexRuntimeV2Client] = None
LAMBDA_AGENT_ASSIST_FUNCTION_ARN: str
DYNAMODB_TABLE_NAME: str

SETTINGS: Dict[str, Any]

LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")
EVENT_LOOP = asyncio.get_event_loop()

CALL_EVENT_TYPE_TO_STATUS = {
    "START": "STARTED",
    "END": "ENDED",
    "ADD_S3_RECORDING_URL": "ENDED",
}

# DEFAULT_CUSTOMER_PHONE_NUMBER used to replace an invalid CustomerPhoneNumber
# such as seen from calls originating with Skype ('anonymous')
DEFAULT_CUSTOMER_PHONE_NUMBER = getenv("DEFAULT_CUSTOMER_PHONE_NUMBER", "+18005550000")

SentimentLabelType = Literal["NEGATIVE", "MIXED", "NEUTRAL", "POSITIVE"]
ChannelType = Literal["AGENT", "CALLER"]
StatusType = Literal["STARTED", "TRANSCRIBING", "ERRORED", "ENDED"]
SentimentPeriodType = Literal["QUARTER"]

class SentimentEntry(TypedDict):
    """Sentiment Shape
    Held in a list per channel
    """
    Id: str
    BeginOffsetMillis: float
    EndOffsetMillis: float
    Sentiment: SentimentLabelType
    Score: float

class SentimentEntry(TypedDict):
    """Sentiment Shape
    Held in a list per channel
    """
    Id: str
    BeginOffsetMillis: float
    EndOffsetMillis: float
    Sentiment: SentimentLabelType
    Score: float
class SentimentPerChannel(TypedDict):
    """StatePerChannel Shape
    Holds state per channel under StatePerCallId. Use to keep values needed
    for statistics and aggregations.
    """

    SentimentList: List[SentimentEntry]

class SentimentByPeriodEntry(TypedDict):
    """Sentiment By Period Shape"""
    BeginOffsetMillis: float
    EndOffsetMillis: float
    Score: float

class Sentiment(TypedDict):
    """Sentiment Shape"""
    OverallSentiment: Dict[ChannelType, float]
    SentimentByPeriod: Dict[SentimentPeriodType, Dict[ChannelType, List[SentimentByPeriodEntry]]]

##########################################################################
# Transcripts
##########################################################################


def add_transcript_segments(
    message: Dict[str, object],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Transcript Segment GraphQL Mutation"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    tasks = []
    if message:
        issues_detected = message.get("IssuesDetected", None)
        transcript = message["Transcript"]
        if "OriginalTranscript" not in message:
            message["OriginalTranscript"] = transcript
        if issues_detected and len(issues_detected) > 0:
            LOGGER.debug("issue detected in add transcript segment")
            offsets = issues_detected[0].get("CharacterOffsets")
            start = int(offsets.get("Begin"))
            end = int(offsets.get("End"))
            transcript = f"{transcript[:start]}<span class='issue-span'>{transcript[start:end]}</span>{transcript[end:]}<br/><span class='issue-pill'>Issue Detected</span>"
            message["Transcript"] = transcript

        query = dsl_gql(
            DSLMutation(
                schema.Mutation.addTranscriptSegment.args(input=message).select(
                    *transcript_segment_fields(schema),
                )
            )
        )
        def ignore_exception_fn(e): return True if (
            e["message"] == 'item put condition failure') else False
        tasks.append(
            execute_gql_query_with_retries(
                query,
                client_session=appsync_session,
                logger=LOGGER,
                should_ignore_exception_fn=ignore_exception_fn,
            ),
        )

    return tasks


async def add_sentiment_to_transcript(
    message: Dict[str, Any],
    sentiment_analysis_args: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
):
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    transcript_segment_with_sentiment = await transform_segment_to_add_sentiment(message, sentiment_analysis_args)

    result = {}
    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addTranscriptSegment.args(input=transcript_segment_with_sentiment).select(
                *transcript_segment_fields(schema),
                *transcript_segment_sentiment_fields(schema),
            )
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    return result


def add_transcript_sentiment_analysis(
    message: Dict[str, Any],
    sentiment_analysis_args: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Transcript Sentiment GraphQL Mutation"""

    tasks = []

    task = add_sentiment_to_transcript(message, sentiment_analysis_args, appsync_session)
    tasks.append(task)

    return tasks


async def execute_create_call_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.createCall.args(input=message).select(
                schema.CreateCallOutput.CallId
            )
        )
    )

    def ignore_exception_fn(e): return True if (
        e["message"] == 'item put condition failure') else False
    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
        should_ignore_exception_fn=ignore_exception_fn,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result


async def execute_update_call_status_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    status = CALL_EVENT_TYPE_TO_STATUS.get(message.get("EventType"))
    if not status:
        error_message = "unrecognized status from event type in update call"
        raise TypeError(error_message)

    if status == "STARTED":
        # STARTED status is set by createCall - skip update mutation
        return {"ok": True}

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updateCallStatus.args(input={**message, "Status": status}).select(
                *call_fields(schema)
            )
        )
    )
    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result

async def execute_get_transcript_segments_query(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    call_id = message.get("CallId")
    if not call_id:
        error_message = "callid does not exist"
        raise TypeError(error_message)

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    # get_transcript_segments_input = {
    #     "CallId": call_id
    # }
    query = dsl_gql(
        DSLQuery(
            schema.Query.getTranscriptSegmentsWithSentiment.args(callId=call_id).select(
                schema.TranscriptSegmentsWithSentimentList.TranscriptSegmentsWithSentiment.select(
                    schema.TranscriptSegmentWithSentiment.PK,
                    schema.TranscriptSegmentWithSentiment.SK,
                    schema.TranscriptSegmentWithSentiment.CallId,
                    schema.TranscriptSegmentWithSentiment.Channel,
                    schema.TranscriptSegmentWithSentiment.SegmentId,
                    schema.TranscriptSegmentWithSentiment.StartTime,
                    schema.TranscriptSegmentWithSentiment.EndTime,
                    schema.TranscriptSegmentWithSentiment.Sentiment,
                    schema.TranscriptSegmentWithSentiment.SentimentWeighted,
                )
            )
        )
    )
    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("get transcript segments result", extra=dict(query=query_string, result=result))

    return result

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

async def get_aggregated_sentiment(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    call_id = message.get("CallId")
    if not call_id:
        error_message = "callid does not exist"
        raise TypeError(error_message)
    
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)
 
    result = await execute_get_transcript_segments_query(
        message=message,
        appsync_session=appsync_session
    )
 
    sentiment_entry_list_by_channel: Dict[ChannelType, SentimentPerChannel] = {}

    for segment in result.get("getTranscriptSegmentsWithSentiment").get("TranscriptSegmentsWithSentiment"):
        channel = segment.get("Channel", None)
        if channel and channel in ["AGENT", "CALLER"] :
            if segment.get("SentimentWeighted", None):
                LOGGER.debug("Aggregating sentiment entry", extra=segment)
                sentiment_entry : SentimentEntry = {
                    "Id" : segment["SegmentId"],
                    "BeginOffsetMillis": segment["StartTime"] * 1000,
                    "EndOffsetMillis": segment["EndTime"] * 1000,
                    "Sentiment": segment["Sentiment"],
                    "Score": segment["SentimentWeighted"]
                }
                if channel in sentiment_entry_list_by_channel:
                    tmp = sentiment_entry_list_by_channel[channel].get("SentimentList", [])
                    tmp.append(sentiment_entry)
                    sentiment_list_obj = {
                        "SentimentList": tmp
                    }
                else:
                    sentiment_list_obj = {
                        "SentimentList": [sentiment_entry]
                    }

                sentiment_entry_list_by_channel[channel] = sentiment_list_obj
                
    aggregated_sentiment:Sentiment = {}
    overall_sentiment:Dict[ChannelType, float] = {}
    sentiment_by_period_by_channel:Dict[ChannelType, List[SentimentByPeriodEntry]] = {}
    
    for channel in sentiment_entry_list_by_channel.keys():
        sentiment_list = sentiment_entry_list_by_channel[channel].get("SentimentList", [])
        sentiment_scores = [i["Score"] for i in sentiment_list]
        sentiment_average = fmean(sentiment_scores) if sentiment_scores else 0

        sentiment_per_quarter = (
            _get_sentiment_per_quarter(sentiment_list) if sentiment_list else []
        )

        overall_sentiment[channel] = sentiment_average
        sentiment_by_period_by_channel[channel] = sentiment_per_quarter
    
    LOGGER.debug("Overall Sentiment: ", extra=dict(DebugOverallSentiment=overall_sentiment))
    LOGGER.debug("Sentiment by Period: ", extra=dict(DebugSentimentByPeriod=sentiment_by_period_by_channel))
        
    aggregated_sentiment = {
        "OverallSentiment": overall_sentiment,
        "SentimentByPeriod": {
                "QUARTER": sentiment_by_period_by_channel
            },
        }

    return aggregated_sentiment

async def get_aggregate_call_data(
    message: Dict[str, object],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:
    
    call_id = message.get("CallId")
    if not call_id:
        error_message = "callid does not exist"
        raise TypeError(error_message)
    
    total_duration = float(message.get("EndTime", 0.0)) * 1000

    sentiment = await get_aggregated_sentiment(
        message=message,
        appsync_session=appsync_session
    ) 
    
    updated_at = message.get("UpdatedAt", datetime.utcnow().astimezone().isoformat())
    event_type = message.get("EventType", "")
    if event_type == "END":
        call_aggregation: Dict[str, object] = {
            "CallId": call_id,
            "Sentiment": sentiment
        }
    else:
        call_aggregation: Dict[str, object] = {
            "CallId": call_id,
            "TotalConversationDurationMillis": total_duration,
            "Sentiment": sentiment,
            "UpdatedAt": updated_at
        }

    return call_aggregation
    
async def get_call_aggregation_tasks(
    message: Dict[str, object],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:

    call_aggregation = await get_aggregate_call_data(
        message=message,
        appsync_session=appsync_session
    )
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updateCallAggregation.args(
                input=call_aggregation
            ).select(*call_fields(schema))
        )
    )

    tasks = []

    def ignore_exception_fn(e): return True if (
        e["message"] == 'item put condition failure') else False
    tasks.append(
        execute_gql_query_with_retries(
            query,
            client_session=appsync_session,
            logger=LOGGER,
            should_ignore_exception_fn=ignore_exception_fn,
        ),
    )

    return tasks


async def execute_update_call_aggregation_mutation(
    message: Dict[str, object],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    call_aggregation = await get_aggregate_call_data(
        message=message,
        appsync_session=appsync_session
    )

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updateCallAggregation.args(
                input=call_aggregation
            ).select(*call_fields(schema))
        )
    )

    def ignore_exception_fn(e): return True if (
        e["message"] == 'item put condition failure') else False
    
    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
        should_ignore_exception_fn=ignore_exception_fn,

    )

    query_string = print_ast(query)
    LOGGER.debug(
        "transcript aggregation mutation", extra=dict(query=query_string, result=result)
    )
    return result

async def execute_add_s3_recording_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    recording_url = message.get("RecordingUrl")
    if not recording_url:
        error_message = "recording url doesn't exist in add s3 recording url event"
        raise TypeError(error_message)

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updateRecordingUrl.args(
                input={**message, "RecordingUrl": recording_url}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result


async def execute_add_pca_url_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    pca_url = message.get("PcaUrl")
    if not pca_url:
        error_message = "pca url doesn't exist in add pca url event"
        raise TypeError(error_message)

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updatePcaUrl.args(
                input={**message, "PcaUrl": pca_url}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result


async def execute_add_call_category_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    categories = message["CategoryEvent"]["MatchedCategories"]
    if (len(categories) == 0):
        error_message = "No MatchedCategories in ADD_CALL_CATEGORY event"
        raise TypeError(error_message)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addCallCategory.args(
                input={**message, "CallCategories": categories}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result


async def execute_add_issues_detected_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    issues_detected = message.get("IssuesDetected", None)
    issueText = ""
    if issues_detected and len(issues_detected) > 0:
        LOGGER.debug("issue detected in add issues detected mutation")
        offsets = issues_detected[0].get("CharacterOffsets")
        start = int(offsets.get("Begin"))
        end = int(offsets.get("End"))
        if (start >= 0 and end >= 0):
            transcript = message["Transcript"]
            issueText = transcript[start:end]

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addIssuesDetected.args(
                input={**message, "IssuesDetected": issueText}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result

async def execute_add_call_summary_text_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    calltext = message.get("CallSummaryText", None)
    call_summary_text = ""
    if calltext and len(calltext) > 0:
        call_summary_text = calltext

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    
    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addCallSummaryText.args(
                input={**message, "CallSummaryText": call_summary_text}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result


async def execute_update_agent_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    agentId = message.get("AgentId")
    if not agentId:
        error_message = "AgentId doesn't exist in UPDATE_AGENT event"
        raise TypeError(error_message)

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.updateAgent.args(
                input={**message, "AgentId": agentId}
            ).select(*call_fields(schema))
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("query result", extra=dict(query=query_string, result=result))

    return result

##########################################################################
# Call Categories
##########################################################################


async def send_call_category(
    transcript_segment_args: Dict[str, Any],
    category: str,
    appsync_session: AppsyncAsyncClientSession
):
    """Send Call Category Transcript Segment"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    transcript_segment = {**transcript_segment_args, "Transcript": category}

    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                *transcript_segment_fields(schema),
            )
        )
    )

    result = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    return result


async def publish_sns_category(
    sns_client: SNSClient,
    category_name: str,
    call_id: str
):
    LOGGER.debug("Publishing Call Category to SNS")
    isAlert = False
    if "AlertRegEx" in SETTINGS:
        isMatch = SETTINGS["AlertRegEx"].match(category_name)
        if isMatch:
            isAlert = True
    
    result = await publish_sns(category_name=category_name,
                               call_id=call_id,
                               sns_topic_arn=SNS_TOPIC_ARN,
                               sns_client=sns_client,
                               alert=isAlert
                               )
                        
    return result


def add_call_category(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
    sns_client: SNSClient
) -> List[Coroutine]:
    """Add Categories GraphQL Mutations"""
    # pylint: disable=too-many-locals
    LOGGER.debug("Detected Call Category")

    tasks = []
    for category in message["CategoryEvent"]["MatchedCategories"]:
        # Publish SNS message for the category
        sns_task = publish_sns_category(
            sns_client=sns_client,
            category_name=category,
            call_id=message["CallId"]
        )
        tasks.append(sns_task)
        # Insert Category marker into transcript, if timestamps are provided in the event.
        try:
            timestampRanges = message["CategoryEvent"]["MatchedDetails"][category]["TimestampRanges"]
        except KeyError:
            LOGGER.debug("Category: %s has no TimestampRanges. Skip transcript insertion.", category)
            continue
        for timestampRange in timestampRanges:
            start_time = timestampRange["EndOffsetMillis"]/1000
            end_time = start_time + 0.1
            send_call_category_args = []
            send_call_category_args.append(
                dict(
                    category=category,
                    transcript_segment_args=dict(
                        CallId=message["CallId"],
                        Channel="CATEGORY_MATCH",
                        CreatedAt=message["CreatedAt"],
                        EndTime=end_time,
                        ExpiresAfter=get_ttl(),
                        SegmentId=str(uuid.uuid4()),
                        StartTime=start_time,
                        IsPartial=False,
                        Status="TRANSCRIBING",
                    ),
                )
            )
            for call_category_args in send_call_category_args:
                task = send_call_category(
                    appsync_session=appsync_session,
                    **call_category_args,
                )
                tasks.append(task)

    return tasks


##########################################################################
# Lex Agent Assist
##########################################################################
def is_qnabot_noanswer(bot_response):
    if (
        bot_response["sessionState"]["dialogAction"]["type"] == "Close"
        and (
            bot_response["sessionState"]
            .get("sessionAttributes", {})
            .get("qnabot_gotanswer")
            == "false"
        )
    ):
        return True
    return False


def get_lex_agent_assist_message(bot_response):
    message = ""
    if is_qnabot_noanswer(bot_response):
        # ignore 'noanswer' responses from QnABot
        LOGGER.debug("QnABot \"Dont't know\" response - ignoring")
        return ""
    # Use markdown if present in appContext.altMessages.markdown session attr (Lex Web UI / QnABot)
    appContextJSON = bot_response.get("sessionState", {}).get(
        "sessionAttributes", {}).get("appContext")
    if appContextJSON:
        appContext = json.loads(appContextJSON)
        markdown = appContext.get("altMessages", {}).get("markdown")
        if markdown:
            message = markdown
    # otherwise use bot message
    if not message and "messages" in bot_response and bot_response["messages"]:
        message = bot_response["messages"][0]["content"]
    return message


async def send_lex_agent_assist(
    transcript_segment_args: Dict[str, Any],
    content: str,
    appsync_session: AppsyncAsyncClientSession,
):
    """Sends Lex Agent Assist Requests"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    call_id = transcript_segment_args["CallId"]

    LOGGER.debug("Bot Request: %s", content)

    bot_response: RecognizeTextResponseTypeDef = await recognize_text_lex(
        text=content,
        session_id=call_id,
        lex_client=LEXV2_CLIENT,
        bot_id=LEX_BOT_ID,
        bot_alias_id=LEX_BOT_ALIAS_ID,
        locale_id=LEX_BOT_LOCALE_ID,
    )

    LOGGER.debug("Bot Response: ", extra=bot_response)

    result = {}
    transcript = get_lex_agent_assist_message(bot_response)
    if transcript:
        transcript_segment = {**transcript_segment_args, "Transcript": transcript}

        query = dsl_gql(
            DSLMutation(
                schema.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                    *transcript_segment_fields(schema),
                )
            )
        )

        result = await execute_gql_query_with_retries(
            query,
            client_session=appsync_session,
            logger=LOGGER,
        )

    return result


def add_lex_agent_assistances(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Lex Agent Assist GraphQL Mutations"""
    # pylint: disable=too-many-locals
    call_id: str = message["CallId"]
    channel: str = message["Channel"]
    is_partial: bool = message["IsPartial"]
    segment_id: str = message["SegmentId"]
    start_time: float = message["StartTime"]
    end_time: float = message["EndTime"]
    end_time = float(end_time) + 0.001  # UI sort order
    # Use "OriginalTranscript", if defined (optionally set by transcript lambda hook fn)"
    transcript: str = message.get("OriginalTranscript", message["Transcript"])
    created_at = datetime.utcnow().astimezone().isoformat()
    status: str = message["Status"]

    send_lex_agent_assist_args = []
    if (channel == "CALLER" and not is_partial):
        send_lex_agent_assist_args.append(
            dict(
                content=transcript,
                transcript_segment_args=dict(
                    CallId=call_id,
                    Channel="AGENT_ASSISTANT",
                    CreatedAt=created_at,
                    EndTime=end_time,
                    ExpiresAfter=get_ttl(),
                    IsPartial=is_partial,
                    SegmentId=str(uuid.uuid4()),
                    StartTime=start_time,
                    Status="TRANSCRIBING",
                ),
            )
        )

    tasks = []
    for agent_assist_args in send_lex_agent_assist_args:
        task = send_lex_agent_assist(
            appsync_session=appsync_session,
            **agent_assist_args,
        )
        tasks.append(task)

    return tasks

##########################################################################
# Lambda Agent Assist
##########################################################################


def get_lambda_agent_assist_message(lambda_response):
    message = ""
    try:
        payload = json.loads(lambda_response.get("Payload").read().decode("utf-8"))
        # Lambda result payload should include field 'message'
        message = payload["message"]
    except Exception as error:
        LOGGER.error(
            "Agent assist Lambda result payload parsing exception. Lambda must return object with key 'message'",
            extra=error,
        )
    return message


async def send_lambda_agent_assist(
    transcript_segment_args: Dict[str, Any],
    content: str,
    appsync_session: AppsyncAsyncClientSession,
):
    """Sends Lambda Agent Assist Requests"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    call_id = transcript_segment_args["CallId"]

    payload = {
        'text': content,
        'call_id': call_id,
        'transcript_segment_args': transcript_segment_args,
        'dynamodb_table_name': DYNAMODB_TABLE_NAME,
        'dynamodb_pk': f"c#{call_id}",
    }

    LOGGER.debug("Agent Assist Lambda Request: %s", content)

    lambda_response: InvocationResponseTypeDef = await invoke_lambda(
        payload=payload,
        lambda_client=LAMBDA_CLIENT,
        lambda_agent_assist_function_arn=LAMBDA_AGENT_ASSIST_FUNCTION_ARN,
    )

    LOGGER.debug("Agent Assist Lambda Response: ", extra=lambda_response)

    result = {}
    transcript = get_lambda_agent_assist_message(lambda_response)
    if transcript:
        transcript_segment = {**transcript_segment_args, "Transcript": transcript}

        query = dsl_gql(
            DSLMutation(
                schema.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                    *transcript_segment_fields(schema),
                )
            )
        )

        result = await execute_gql_query_with_retries(
            query,
            client_session=appsync_session,
            logger=LOGGER,
        )

    return result


def add_lambda_agent_assistances(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Lambda Agent Assist GraphQL Mutations"""
    # pylint: disable=too-many-locals
    call_id: str = message["CallId"]
    channel: str = message["Channel"]
    is_partial: bool = message["IsPartial"]
    segment_id: str = message["SegmentId"]
    start_time: float = message["StartTime"]
    end_time: float = message["EndTime"]
    end_time = float(end_time) + 0.001  # UI sort order
    # Use "OriginalTranscript", if defined (optionally set by transcript lambda hook fn)"
    transcript: str = message.get("OriginalTranscript", message["Transcript"])
    created_at = datetime.utcnow().astimezone().isoformat()

    send_lambda_agent_assist_args = []
    if (channel == "CALLER" and not is_partial):
        send_lambda_agent_assist_args.append(
            dict(
                content=transcript,
                transcript_segment_args=dict(
                    CallId=call_id,
                    Channel="AGENT_ASSISTANT",
                    CreatedAt=created_at,
                    EndTime=end_time,
                    ExpiresAfter=get_ttl(),
                    IsPartial=is_partial,
                    SegmentId=str(uuid.uuid4()),
                    StartTime=start_time,
                    Status="TRANSCRIBING",
                ),
            )
        )

    tasks = []
    for agent_assist_args in send_lambda_agent_assist_args:
        task = send_lambda_agent_assist(
            appsync_session=appsync_session,
            **agent_assist_args,
        )
        tasks.append(task)

    return tasks

##########################################################################
# Transcript Lambda Hook
# User provided function should return a copy of the input event with
# optionally modified "Transcript" field (to support custom redaction or
# other transcript manipulation.
# The original transcript can be optionally returned as "OriginalTranscript"
# to be used as input for Agent Assist bot or Lambda, otherwise "Transcript"
# field is used for Agent Assist input.
##########################################################################


def invoke_transcript_lambda_hook(
    message: Dict[str, Any]
):
    if (message.get("IsPartial") == False or TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY == False):
        LOGGER.debug("Transcript Lambda Hook Arn: %s", TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN)
        LOGGER.debug("Transcript Lambda Hook Request: %s", message)
        lambda_response = LAMBDA_HOOK_CLIENT.invoke(
            FunctionName=TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN,
            InvocationType='RequestResponse',
            Payload=json.dumps(message)
        )
        LOGGER.debug("Transcript Lambda Hook Response: ", extra=lambda_response)
        try:
            message = json.loads(lambda_response.get("Payload").read().decode("utf-8"))
        except Exception as error:
            LOGGER.error(
                "Transcript Lambda Hook result payload parsing exception. Lambda must return JSON object with (modified) input event fields",
                extra=error,
            )
    return message



##########################################################################
# Main event processing
##########################################################################

async def execute_process_event_api_mutation(
    message: Dict[str, Any],
    settings: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
    sns_client: SNSClient,
    agent_assist_args: Dict[str, Any],
    sentiment_analysis_args: Dict[str, Any]
) -> Dict[Literal["successes", "errors"], List]:

    """Executes AppSync API Mutation"""
    # pylint: disable=global-statement
    global LEXV2_CLIENT
    global IS_LEX_AGENT_ASSIST_ENABLED
    global LEX_BOT_ID
    global LEX_BOT_ALIAS_ID
    global LEX_BOT_LOCALE_ID
    global LAMBDA_CLIENT
    global LAMBDA_AGENT_ASSIST_FUNCTION_ARN
    global DYNAMODB_TABLE_NAME
    global SETTINGS
    # pylint: enable=global-statement

    LEXV2_CLIENT = agent_assist_args.get("lex_client")
    IS_LEX_AGENT_ASSIST_ENABLED = LEXV2_CLIENT is not None
    LEX_BOT_ID = agent_assist_args.get("lex_bot_id", "")
    LEX_BOT_ALIAS_ID = agent_assist_args.get("lex_bot_alias_id", "")
    LEX_BOT_LOCALE_ID = agent_assist_args.get("lex_bot_locale_id", "")
    LAMBDA_CLIENT = agent_assist_args.get("lambda_client")
    IS_LAMBDA_AGENT_ASSIST_ENABLED = LAMBDA_CLIENT is not None
    LAMBDA_AGENT_ASSIST_FUNCTION_ARN = agent_assist_args.get("lambda_agent_assist_function_arn", "")
    DYNAMODB_TABLE_NAME = agent_assist_args.get("dynamodb_table_name", "")
    SETTINGS = settings

    return_value: Dict[Literal["successes", "errors"], List] = {
        "successes": [],
        "errors": [],
    }

    message["ExpiresAfter"] = get_ttl()
    event_type = message.get("EventType", "")

    if event_type == "START":
        # CREATE CALL
        LOGGER.debug("CREATE CALL")

        response = await execute_create_call_mutation(
            message=message,
            appsync_session=appsync_session
        )

        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

    elif event_type in [
        "END",
    ]:
        LOGGER.debug("END Event: update status")
        response = await execute_update_call_status_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)
        
        if (IS_TRANSCRIPT_SUMMARY_ENABLED):
            LAMBDA_HOOK_CLIENT.invoke(
                FunctionName=ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN,
                InvocationType='Event',
                Payload=json.dumps(message)
            )
            LOGGER.debug("END Event: Invoked Async Transcript Summary Lambda")
      

        response = await execute_update_call_aggregation_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)
        

    elif event_type == "ADD_SUMMARY":

        LOGGER.debug("ADD_SUMMARY MUTATION ")
        response = await execute_add_call_summary_text_mutation(
            message=message,
            appsync_session=appsync_session
        )
 
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

    elif event_type == "ADD_TRANSCRIPT_SEGMENT":

        # ADD_TRANSCRIPT_SEGMENT event supports these 3 types of message structure.
        #   The logic for populating transcripts, sentiment values and agent assist messages depend on
        #    which one of these 3 json structures are populated in the KDS Event message.
        #
        #  1. custom i.e. source populates invidividual transcript fields, including optional sentiment field
        #  2. TranscriptEvent - json structure from standard Transcribe API
        #  3. UtteranceEvent - json structure from TCA streaming API

        utteranceEvent = message.get("UtteranceEvent", None)
        if utteranceEvent:
            participantRole = utteranceEvent.get("ParticipantRole", None)
            if not participantRole:
                return return_value
        # Invoke custom lambda hook (if any) and use returned version of message.

        normalized_message = {
            **normalize_transcript_segment({**message}),
        }

        if (TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN):
            normalized_message = invoke_transcript_lambda_hook(normalized_message)

        issues_detected = normalized_message.get("IssuesDetected", None)
        if issues_detected and len(issues_detected) > 0:
            LOGGER.debug("Add Issues Detected to Call Summary")
            response = await execute_add_issues_detected_mutation(
                message=normalized_message,
                appsync_session=appsync_session
            )
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)


        add_transcript_tasks = []
        add_transcript_sentiment_tasks = []
        if IS_SENTIMENT_ANALYSIS_ENABLED and not normalized_message["IsPartial"]:
            LOGGER.debug("Add Transcript Segment with Sentiment Analysis")
            add_transcript_sentiment_tasks = add_transcript_sentiment_analysis(
                message=normalized_message,
                sentiment_analysis_args=sentiment_analysis_args,
                appsync_session=appsync_session,
            )
        else:
            LOGGER.debug("Add Transcript Segment")
            add_transcript_tasks = add_transcript_segments(
                message=normalized_message,
                appsync_session=appsync_session,
            )

        add_lex_agent_assists_tasks = []
        if IS_LEX_AGENT_ASSIST_ENABLED:
            add_lex_agent_assists_tasks = add_lex_agent_assistances(
                message=normalized_message,
                appsync_session=appsync_session,
            )

        add_lambda_agent_assists_tasks = []
        if IS_LAMBDA_AGENT_ASSIST_ENABLED:
            add_lambda_agent_assists_tasks = add_lambda_agent_assistances(
                message=normalized_message,
                appsync_session=appsync_session,
            )

        update_call_aggregation_tasks = []
        if not normalized_message["IsPartial"]:
            update_call_aggregation_tasks = await get_call_aggregation_tasks(
                message=normalized_message,
                appsync_session=appsync_session,
            )

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_transcript_sentiment_tasks,
            *add_lex_agent_assists_tasks,
            *add_lambda_agent_assists_tasks,
            *update_call_aggregation_tasks,
            # *add_tca_agent_assist_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)

    elif event_type == "ADD_CALL_CATEGORY":
        LOGGER.debug("Add Call Category to Call details")
        response = await execute_add_call_category_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

        LOGGER.debug("Add Call Category to Transcript segments")
        add_call_category_tasks = []
        add_call_category_tasks = add_call_category(
            message=message,
            appsync_session=appsync_session,
            sns_client=sns_client
        )
        task_responses = await asyncio.gather(
            *add_call_category_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)

    elif event_type == "ADD_S3_RECORDING_URL":
        # ADD S3 RECORDING URL
        LOGGER.debug("Add recording url")
        response = await execute_add_s3_recording_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

    elif event_type == "ADD_PCA_URL":
        # ADD PCA URL
        LOGGER.debug("Add PCA url")
        response = await execute_add_pca_url_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

    elif event_type == "UPDATE_AGENT":
        # UPDATE AGENT
        LOGGER.debug("Update AgentId for call")
        response = await execute_update_agent_mutation(
            message=message,
            appsync_session=appsync_session
        )
        if isinstance(response, Exception):
            return_value["errors"].append(response)
        else:
            return_value["successes"].append(response)

    else:
        LOGGER.warning("unknown event type [%s]", event_type)

    return return_value
