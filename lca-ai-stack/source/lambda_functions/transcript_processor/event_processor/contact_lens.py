# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Contact Lens API Mutation Processor
"""
import asyncio
from datetime import datetime
from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
import uuid

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


# pylint: enable=import-error

if TYPE_CHECKING:
    from mypy_boto3_lexv2_runtime.type_defs import RecognizeTextResponseTypeDef
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
else:
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object

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


LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")

EVENT_LOOP = asyncio.get_event_loop()

# XXX workaround - this should be moved to the Tumbling Window state
# Contact Lens sends individual Utterances (partials)
# This map is used to concatenate the invididual Utterances
UTTERANCES_MAP: Dict[str, str] = {}

# Contact Lens doesn't provide the low level scores
SENTIMENT_SCORE = dict(
    Positive=0,
    Negative=0,
    Neutral=0,
    Mixed=0,
)
SENTIMENT_WEIGHT = dict(POSITIVE=5, NEGATIVE=-5, NEUTRAL=0, MIXED=0)


##########################################################################
# Call Status
##########################################################################
def transform_message_to_call_status(message: Dict) -> Dict[str, object]:
    """Transforms Kinesis Stream Transcript Payload to addTranscript API"""
    call_id = message.get("ContactId")
    event_type = message.get("EventType")

    if event_type == "STARTED":
        # XXX hardcoded phone numbers since Contact Lens doesn't include it
        # Need to stream contact records and get call metadata from it
        customer_phone_number = CUSTOMER_PHONE_NUMBER
        system_phone_number = SYSTEM_PHONE_NUMBER
        return dict(
            CallId=call_id,
            CustomerPhoneNumber=customer_phone_number,
            SystemPhoneNumber=system_phone_number,
        )

    updated_at = datetime.utcnow().astimezone().isoformat()

    return dict(
        CallId=call_id,
        Status=event_type,
        UpdatedAt=updated_at,
    )


async def update_call_status(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict[Literal["successes", "errors"], List]:
    """Add Transcript Segment GraphQL Mutation"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    status = {
        **transform_message_to_call_status(message),
    }
    event_type = message.get("EventType")

    return_value: Dict[Literal["successes", "errors"], List] = {
        "successes": [],
        "errors": [],
    }

    if event_type == "STARTED":
        query = dsl_gql(
            DSLMutation(
                schema.Mutation.createCall.args(input=status).select(schema.CreateCallOutput.CallId)
            )
        )
    else:
        query = dsl_gql(
            DSLMutation(
                schema.Mutation.updateCallStatus.args(input=status).select(*call_fields(schema))
            )
        )

    try:
        response = await execute_gql_query_with_retries(
            query,
            client_session=appsync_session,
            logger=LOGGER,
        )
        LOGGER.debug("appsync mutation response", extra=dict(response=response))
        return_value["successes"].append(response)
    except Exception as error:  # pylint: disable=broad-except
        return_value["errors"].append(error)

    return return_value


##########################################################################
# Transcripts
##########################################################################
def transform_segment_to_add_transcript(segment: Dict) -> Dict[str, object]:
    """Transforms Kinesis Stream Transcript Payload to addTranscript API"""
    call_id: str = segment["CallId"]
    is_partial: bool
    segment_item: Dict[str, Any]
    segment_id: str
    transcript: str
    sentiment_args = {}

    # partial transcript
    if "Utterance" in segment:
        is_partial = True
        segment_item = segment["Utterance"]
        segment_id = segment_item["TranscriptId"]
        content = segment_item["PartialContent"]
        UTTERANCES_MAP[segment_id] = UTTERANCES_MAP.get(segment_id, "") + " " + content
        transcript = UTTERANCES_MAP[segment_id]
    # final transcript
    elif "Transcript" in segment:
        is_partial = False
        segment_item = segment["Transcript"]
        segment_id = segment_item["Id"]
        transcript = segment_item["Content"]
        # delete utterance concatenatin from global map
        if segment_id in UTTERANCES_MAP:
            del UTTERANCES_MAP[segment_id]
        if "Sentiment" in segment_item:
            sentiment = segment_item.get("Sentiment", "NEUTRAL")
            sentiment_args = dict(
                Sentiment=sentiment,
                SentimentScore=SENTIMENT_SCORE,
                SentimentWeighted=SENTIMENT_WEIGHT.get(sentiment, 0),
            )
    else:
        raise ValueError("Invalid segment type")

    channel = segment_item.get("ParticipantRole", "AGENT")
    # contact lens uses "CUSTOMER" and LCA expects "CALLER"
    if channel == "CUSTOMER":
        channel = "CALLER"
    created_at = datetime.utcnow().astimezone().isoformat()
    # Contact Lens times are in Milliseconds
    # Changing to seconds to normalize units used by the transcript state manager which uses
    # seconds per the Transcribe streaming API
    start_time: float = segment_item["BeginOffsetMillis"] / 1000
    end_time: float = segment_item["EndOffsetMillis"] / 1000

    return dict(
        CallId=call_id,
        Channel=channel,
        CreatedAt=created_at,
        EndTime=end_time,
        IsPartial=is_partial,
        SegmentId=segment_id,
        StartTime=start_time,
        Status="TRANSCRIBING",
        Transcript=transcript,
        **sentiment_args,
    )


def add_transcript_segments(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Transcript Segment GraphQL Mutation"""
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    call_id = message["ContactId"]

    tasks = []
    for segment in message.get("Segments", []):
        # only handle utterances and transcripts - delegate categories to agent assist
        if "Utterance" not in segment and "Transcript" not in segment:
            continue

        transcript_segment = {
            **transform_segment_to_add_transcript({**segment, "CallId": call_id}),
        }

        if transcript_segment:
            query = dsl_gql(
                DSLMutation(
                    schema.Mutation.addTranscriptSegment.args(input=transcript_segment).select(
                        *transcript_segment_fields(schema),
                        *transcript_segment_sentiment_fields(schema),
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


##########################################################################
# Contact Lens Agent Assist
##########################################################################
def transform_segment_to_categories_agent_assist(
    category: str,
    category_details: Dict[str, Any],
    call_id: str,
) -> Dict[str, Any]:
    """Transforms Contact Lens Categories segment payload to Agent Assist"""
    created_at = datetime.utcnow().astimezone().isoformat()
    is_partial = False
    segment_id = str(uuid.uuid4())
    channel = "AGENT_ASSISTANT"

    transcript = f"{category}"
    # get the min and maximum offsets to put a time range
    segment_item = {}
    segment_item["BeginOffsetMillis"] = min(
        (
            point_of_interest["BeginOffsetMillis"]
            for point_of_interest in category_details["PointsOfInterest"]
        )
    )
    segment_item["EndOffsetMillis"] = max(
        (
            point_of_interest["EndOffsetMillis"]
            for point_of_interest in category_details["PointsOfInterest"]
        )
    )

    start_time: float = segment_item["BeginOffsetMillis"] / 1000
    end_time: float = segment_item["EndOffsetMillis"] / 1000

    return dict(
        CallId=call_id,
        Channel=channel,
        CreatedAt=created_at,
        EndTime=end_time,
        IsPartial=is_partial,
        SegmentId=segment_id,
        StartTime=start_time,
        Status="TRANSCRIBING",
        Transcript=transcript,
    )


def transform_segment_to_issues_agent_assist(
    segment: Dict[str, Any],
    issue: Dict[str, Any],
) -> Dict[str, Any]:
    """Transforms Contact Lens Transcript Issues payload to Agent Assist"""
    # pylint: disable=too-many-locals
    call_id: str = segment["CallId"]
    created_at = datetime.utcnow().astimezone().isoformat()
    is_partial = False
    segment_id = str(uuid.uuid4())
    channel = "AGENT_ASSISTANT"
    segment_item = segment["Transcript"]
    transcript = segment_item["Content"]

    issues_detected = segment.get("Transcript", {}).get("IssuesDetected", [])
    if not issues_detected:
        raise ValueError("Invalid issue segment")

    begin_offset = issue["CharacterOffsets"]["BeginOffsetChar"]
    end_offset = issue["CharacterOffsets"]["EndOffsetChar"]
    issue_transcript = transcript[begin_offset:end_offset]
    start_time: float = segment_item["BeginOffsetMillis"] / 1000
    end_time: float = segment_item["EndOffsetMillis"] / 1000

    return dict(
        CallId=call_id,
        Channel=channel,
        CreatedAt=created_at,
        EndTime=end_time,
        IsPartial=is_partial,
        SegmentId=segment_id,
        StartTime=start_time,
        Status="TRANSCRIBING",
        Transcript=issue_transcript,
    )


def add_contact_lens_agent_assistances(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Contact Lens Agent Assist GraphQL Mutations"""
    # pylint: disable=too-many-locals
    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    call_id = message["ContactId"]

    tasks = []
    for segment in message.get("Segments", []):
        # only handle categories and transcripts with issues
        if (
            "Transcript" in segment and not segment["Transcript"].get("IssuesDetected")
        ) and "Categories" not in segment:
            continue

        transcript_segments = []

        categories = segment.get("Categories", {})
        for category in categories.get("MatchedCategories", []):
            category_details = categories["MatchedDetails"][category]
            category_segment = transform_segment_to_categories_agent_assist(
                category=category,
                category_details=category_details,
                call_id=call_id,
            )
            category_segment["Transcript"] = "[Matched Category] " + category_segment["Transcript"]
            transcript_segments.append(category_segment)

        """BobS: Disable display of DetectedIssues"""
        """
        issues_detected = segment.get("Transcript", {}).get("IssuesDetected", [])
        for issue in issues_detected:
            issue_segment = transform_segment_to_issues_agent_assist(
                segment={**segment, "CallId": call_id},
                issue=issue,
            )
            issue_segment["Transcript"] = "[Detected Issue] " + issue_segment["Transcript"]
            transcript_segments.append(issue_segment)
        """

        for transcript_segment in transcript_segments:
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


##########################################################################
# Lex Agent Assist
##########################################################################
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
    if not (
        bot_response["sessionState"]["dialogAction"]["type"] == "Close"
        and (
            bot_response["sessionState"]
            .get("sessionAttributes", {})
            .get("qnabot_gotanswer", "false")
            == "false"
        )
    ):
        if "messages" in bot_response and bot_response["messages"]:
            transcript = bot_response["messages"][0]["content"]
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
    call_id: str = message["ContactId"]
    channel: str = "AGENT_ASSISTANT"
    status: str = "TRANSCRIBING"
    is_partial: bool = False

    created_at: str
    start_time: float
    end_time: float

    send_lex_agent_assist_args = []
    for segment in message.get("Segments", []):
        # only send relevant segments to agent assist
        # BobS: Modified to process Utterance rather than Transcript events 
        # to lower latency
        if not ("Utterance" in segment or "Categories" in segment):
            continue

        if (
            "Utterance" in segment
            and segment["Utterance"].get("ParticipantRole") == "CUSTOMER"
        ):
            is_partial = False
            segment_item = segment["Utterance"]
            content = segment_item["PartialContent"]
            segment_id = str(uuid.uuid4())

            created_at = datetime.utcnow().astimezone().isoformat()
            start_time = segment_item["BeginOffsetMillis"] / 1000
            end_time = segment_item["EndOffsetMillis"] / 1000

            send_lex_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        EndTime=end_time,
                        IsPartial=is_partial,
                        SegmentId=segment_id,
                        StartTime=start_time,
                        Status=status,
                    ),
                )
            )
        # BobS - Issue detection code will not be invoked since we are not processing 
        # Transcript events now.
        issues_detected = segment.get("Transcript", {}).get("IssuesDetected", [])
        if (
            "Transcript" in segment
            and segment["Transcript"].get("ParticipantRole") == "CUSTOMER"
            and not issues_detected
        ):
            is_partial = False
            segment_item = segment["Transcript"]
            content = segment_item["Content"]
            segment_id = str(uuid.uuid4())

            created_at = datetime.utcnow().astimezone().isoformat()
            start_time = segment_item["BeginOffsetMillis"] / 1000
            end_time = segment_item["EndOffsetMillis"] / 1000

            send_lex_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        EndTime=end_time,
                        IsPartial=is_partial,
                        SegmentId=segment_id,
                        StartTime=start_time,
                        Status=status,
                    ),
                )
            )
        issues_detected = segment.get("Transcript", {}).get("IssuesDetected", [])
        for issue in issues_detected:
            issue_segment = transform_segment_to_issues_agent_assist(
                segment={**segment, "CallId": call_id},
                issue=issue,
            )
            send_lex_agent_assist_args.append(
                dict(content=issue_segment["Transcript"], transcript_segment_args=issue_segment),
            )

        categories = segment.get("Categories", {})
        for category in categories.get("MatchedCategories", []):
            category_details = categories["MatchedDetails"][category]
            category_segment = transform_segment_to_categories_agent_assist(
                category=category,
                category_details=category_details,
                call_id=call_id,
            )
            send_lex_agent_assist_args.append(
                dict(
                    content=category_segment["Transcript"],
                    transcript_segment_args=category_segment,
                ),
            )

    tasks = []
    for agent_assist_args in send_lex_agent_assist_args:
        task = send_lex_agent_assist(
            appsync_session=appsync_session,
            **agent_assist_args,
        )
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

    # maps from Contact Lens event status to LCA status
    event_type_map = dict(
        COMPLETED="ENDED", FAILED="ERRORED", SEGMENTS="TRANSCRIBING", STARTED="STARTED"
    )
    event_type = event_type_map.get(message.get("EventType", ""), "")
    message_normalized = {**message, "EventType": event_type}

    if event_type == "TRANSCRIBING":
        add_transcript_tasks = add_transcript_segments(
            message=message_normalized,
            appsync_session=appsync_session,
        )

        add_contact_lens_agent_assist_tasks = add_contact_lens_agent_assistances(
            message=message_normalized,
            appsync_session=appsync_session,
        )

        add_lex_agent_assists_tasks = []
        if IS_LEX_AGENT_ASSIST_ENABLED:
            add_lex_agent_assists_tasks.extend(
                add_lex_agent_assistances(
                    message=message_normalized,
                    appsync_session=appsync_session,
                )
            )

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_contact_lens_agent_assist_tasks,
            *add_lex_agent_assists_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)

    elif event_type in ["STARTED", "ENDED", "ERRORED"]:
        return_value = await update_call_status(
            message=message_normalized,
            appsync_session=appsync_session,
        )
    else:
        LOGGER.warning("unknown event type")

    return return_value
