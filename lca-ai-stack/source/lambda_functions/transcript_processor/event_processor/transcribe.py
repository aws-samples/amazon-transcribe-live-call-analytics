# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Contact Lens API Mutation Processor
"""
import asyncio
from datetime import datetime
from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
import boto3
from botocore.config import Config as BotoCoreConfig

# third-party imports from Lambda layer
from aws_lambda_powertools import Logger
from gql.client import AsyncClientSession as AppsyncAsyncClientSession
from gql.dsl import DSLMutation, DSLSchema, dsl_gql

# imports from Lambda layer
# pylint: disable=import-error
from appsync_utils import execute_gql_query_with_retries
from graphql_helpers import (
    call_fields,
    transcript_segment_fields,
    transcript_segment_sentiment_fields,
)
from lex_utils import recognize_text_lex
from sentiment import ComprehendWeightedSentiment


# pylint: enable=import-error

if TYPE_CHECKING:
    from mypy_boto3_lexv2_runtime.type_defs import RecognizeTextResponseTypeDef
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
    from mypy_boto3_comprehend.client import ComprehendClient
    from mypy_boto3_comprehend.type_defs import DetectSentimentResponseTypeDef
    from mypy_boto3_comprehend.literals import LanguageCodeType
else:
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object
    ComprehendClient = object
    DetectSentimentResponseTypeDef = object
    LanguageCodeType = object

IS_LEX_AGENT_ASSIST_ENABLED = False
LEXV2_CLIENT: Optional[LexRuntimeV2Client] = None
LEX_BOT_ID: str
LEX_BOT_ALIAS_ID: str
LEX_BOT_LOCALE_ID: str

# XXX these are hardcoded phone numbers - Contact Lens doesn't include call metadata
# hardcoding for now. The values must be valid E.164 phone numbers
# Alternatively, we can send the CDR records to Kinesis
# https://docs.aws.amazon.com/connect/latest/adminguide/contact-events.html
CUSTOMER_PHONE_NUMBER = getenv("CUSTOMER_PHONE_NUMBER", "+15714955828")
SYSTEM_PHONE_NUMBER = getenv("SYSTEM_PHONE_NUMBER", "+15712235089")

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)
IS_SENTIMENT_ANALYSIS_ENABLED = getenv("IS_SENTIMENT_ANALYSIS_ENABLED", "true").lower() == "true"
if IS_SENTIMENT_ANALYSIS_ENABLED:
    COMPREHEND_CLIENT: ComprehendClient = BOTO3_SESSION.client("comprehend", config=CLIENT_CONFIG)
    COMPREHEND_LANGUAGE_CODE = getenv("COMPREHEND_LANGUAGE_CODE", "en")

LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")

EVENT_LOOP = asyncio.get_event_loop()

# 
UTTERANCES_MAP: Dict[str, str] = {}

SENTIMENT_SCORE = dict(
    Positive=0,
    Negative=0,
    Neutral=0,
    Mixed=0,
)
SENTIMENT_WEIGHT = dict(POSITIVE=5, NEGATIVE=-5, NEUTRAL=0, MIXED=0)

##########################################################################
# Transcripts
##########################################################################
def transform_segment_to_add_transcript(message: Dict) -> Dict[str, object]:
    """Transforms Kinesis Stream Transcript Payload to addTranscript API"""

    call_id: str = message["CallId"]
    channel: str = message["Channel"]
    stream_arn: str = message["StreamArn"]
    transaction_id: str = message["TransactionId"]
    segment_id: str = message["SegmentId"]
    start_time: float = message["StartTime"]
    end_time: float = message["EndTime"]
    transcript: str = message["Transcript"]
    is_partial: bool = message["IsPartial"]
    created_at = datetime.utcnow().astimezone().isoformat()


    return dict(
        CallId=call_id,
        Channel=channel,
        StreamArn=stream_arn,
        TransactionId=transaction_id,
        SegmentId=segment_id,
        StartTime=start_time,
        EndTime=end_time,
        Transcript=transcript,
        IsPartial=is_partial,
        CreatedAt=created_at,
        Status="TRANSCRIBING",
    )

def add_transcript_segments(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Transcript Segment GraphQL Mutation"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    tasks = []
        
    transcript_segment = {
        **transform_segment_to_add_transcript({**message}),
    }

    if transcript_segment:
        query = dsl_gql(
            DSLMutation(
                schema.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                    *transcript_segment_fields(schema),
                )
            )
        )
        tasks.append(
            execute_gql_query_with_retries(
                query,
                client_session=appsync_session,
                logger=LOGGER,
            ),
        )

    return tasks

async def detect_sentiment(text: str) -> DetectSentimentResponseTypeDef:
    # text_hash = hash(text)
    # if text_hash in self._sentiment_cache:
    #     LOGGER.debug("using sentiment cache on text: [%s]", text)
    #     return self._sentiment_cache[text_hash]

    LOGGER.debug("detect sentiment on text: [%s]", text)
    loop = asyncio.get_running_loop()
    sentiment_future = loop.run_in_executor(
        None,
        lambda: COMPREHEND_CLIENT.detect_sentiment(
            Text=text,
            LanguageCode=COMPREHEND_LANGUAGE_CODE,
        ),
    )
    results = await asyncio.gather(sentiment_future)
    result = results[0]
    # self._sentiment_cache[text_hash] = result
    return result

async def add_sentiment_to_transcript(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
):
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)
        
    transcript_segment = {
        **transform_segment_to_add_transcript({**message}),
    }

    text = transcript_segment["Transcript"]
    LOGGER.debug("detect sentiment on text: [%s]", text)
    sentiment_response:DetectSentimentResponseTypeDef = await detect_sentiment(text)
    LOGGER.debug("Sentiment Response: ", extra=sentiment_response)

    result = {}
    comprehend_weighted_sentiment = ComprehendWeightedSentiment()

    sentiment = {
        k: v for k, v in sentiment_response.items() if k in ["Sentiment", "SentimentScore"]
    }
    if sentiment:
        if sentiment.get("Sentiment") in ["POSITIVE", "NEGATIVE"]:
            sentiment["SentimentWeighted"] = comprehend_weighted_sentiment.get_weighted_sentiment_score(
                    sentiment_response=sentiment_response
                )
    
        transcript_segment_with_sentiment = {
            **transcript_segment,
            **sentiment
        }
        
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
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Transcript Segment GraphQL Mutation"""

    tasks = []

    task = add_sentiment_to_transcript(message, appsync_session)
    tasks.append(task)

    return tasks

async def execute_process_event_api_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
    agent_assist_args: Dict[str, Any],
) -> Dict[Literal["successes", "errors"], List]:
    """Executes AppSync API Mutation"""
    # pylint: disable=global-statement
    global LEXV2_CLIENT
    global IS_LEX_AGENT_ASSIST_ENABLED
    global LEX_BOT_ID
    global LEX_BOT_ALIAS_ID
    global LEX_BOT_LOCALE_ID
    # pylint: enable=global-statement

    LEXV2_CLIENT = agent_assist_args.get("lex_client")
    IS_LEX_AGENT_ASSIST_ENABLED = LEXV2_CLIENT is not None
    LEX_BOT_ID = agent_assist_args.get("lex_bot_id", "")
    LEX_BOT_ALIAS_ID = agent_assist_args.get("lex_bot_alias_id", "")
    LEX_BOT_LOCALE_ID = agent_assist_args.get("lex_bot_locale_id", "")

    return_value: Dict[Literal["successes", "errors"], List] = {
        "successes": [],
        "errors": [],
    }

    event_type = message.get("EventType", "")

    if event_type == "ADD_TRANSCRIPT_SEGMENT":
        add_transcript_tasks = add_transcript_segments(
            message=message,
            appsync_session=appsync_session,
        )

        if IS_SENTIMENT_ANALYSIS_ENABLED and not message.get("IsPartial", True):
            add_transcript_sentiment_tasks = add_transcript_sentiment_analysis(
                message=message,
                appsync_session=appsync_session,
            )

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_transcript_sentiment_tasks,
            # *add_contact_lens_agent_assist_tasks,
            # *add_lex_agent_assists_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)
    else:
        LOGGER.warning("unknown event type")

    return return_value
