# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Contact Lens API Mutation Processor
"""
import asyncio
from datetime import datetime, timedelta
from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
import uuid
import json

# third-party imports from Lambda layer
import boto3
from botocore.config import Config as BotoCoreConfig
from aws_lambda_powertools import Logger
from gql.client import AsyncClientSession as AppsyncAsyncClientSession
from gql.dsl import DSLMutation, DSLSchema, dsl_gql
from graphql.language.printer import print_ast

# imports from Lambda layer
# pylint: disable=import-error
from appsync_utils import execute_gql_query_with_retries
from graphql_helpers import (
    call_fields,
    transcript_segment_fields,
    transcript_segment_sentiment_fields,
)
from lex_utils import recognize_text_lex
from lambda_utils import invoke_lambda
from sns_utils import publish_sns

# pylint: enable=import-error

if TYPE_CHECKING:
    from mypy_boto3_lexv2_runtime.type_defs import RecognizeTextResponseTypeDef
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
    from mypy_boto3_lambda.type_defs import InvocationResponseTypeDef
    from mypy_boto3_lambda.client import LambdaClient
    from mypy_boto3_sns.client import SNSClient
    from boto3 import Session as Boto3Session
else:
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object
    LambdaClient = object
    InvocationResponseTypeDef = object
    Boto3Session = object
    SNSClient = object

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)
TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN = getenv("TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN", "")
ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN = getenv("ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN", "")

TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY = getenv(
    "TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY", "true").lower() == "true"
if TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN or ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN:
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

SNS_TOPIC_ARN = getenv("SNS_TOPIC_ARN", "")

# Contact Lens doesn't include call metadata so we attempt to use API lookups
# to retrieve numbers from defined contact attributes on receipt of STARTED event.
# Connect contact flow must set these (user defined) attributes using values of
# system attribute for Customer Number and Dialled Number.
DEFAULT_CUSTOMER_PHONE_NUMBER = getenv("DEFAULT_CUSTOMER_PHONE_NUMBER", "+18005550000")
DEFAULT_SYSTEM_PHONE_NUMBER = getenv("DEFAULT_SYSTEM_PHONE_NUMBER", "+18005551111")
CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER = getenv(
    "CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER", "LCA Caller Phone Number")
CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER = getenv(
    "CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER", "LCA System Phone Number")

# Get value for DynamboDB TTL field
DYNAMODB_EXPIRATION_IN_DAYS = getenv("DYNAMODB_EXPIRATION_IN_DAYS", "90")

def get_ttl():
    return int((datetime.utcnow() + timedelta(days=int(DYNAMODB_EXPIRATION_IN_DAYS))).timestamp())


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
def get_caller_and_system_phone_numbers_from_connect(instanceId, contactId):
    client = boto3.client('connect')
    response = client.get_contact_attributes(
        InstanceId=instanceId,
        InitialContactId=contactId
    )
    # Try to retrieve customer phone number from contact attribute
    customer_phone_number = response["Attributes"].get(CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER)
    if not customer_phone_number:
        LOGGER.warning(
            f"Unable to retrieve contact attribute: '{CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER}'. Reverting to default.")
        customer_phone_number = DEFAULT_CUSTOMER_PHONE_NUMBER
    # Try to retrieve system phone number from contact attribute: "LCA System Phone Number"
    system_phone_number = response["Attributes"].get(CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER)
    if not system_phone_number:
        LOGGER.warning(
            "Unable to retrieve contact attribute: '{CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER}'. Reverting to default.")
        system_phone_number = DEFAULT_SYSTEM_PHONE_NUMBER
    LOGGER.info(
        f"Setting customer_phone_number={customer_phone_number}, system_phone_number={system_phone_number}")
    return (customer_phone_number, system_phone_number)


def transform_message_to_call_status(message: Dict) -> Dict[str, object]:
    """Transforms Kinesis Stream Transcript Payload to addTranscript API"""
    call_id = message.get("ContactId")
    event_type = message.get("EventType")

    if event_type == "STARTED":
        instanceId = message.get("InstanceId")
        contactId = message.get("ContactId")
        (customer_phone_number, system_phone_number) = get_caller_and_system_phone_numbers_from_connect(
            instanceId, contactId)
        return dict(
            CallId=call_id,
            ExpiresAfter=get_ttl(),
            CustomerPhoneNumber=customer_phone_number,
            SystemPhoneNumber=system_phone_number,
        )

    updated_at = datetime.utcnow().astimezone().isoformat()

    return dict(
        CallId=call_id,
        Status=event_type,
        UpdatedAt=updated_at,
        ExpiresAfter=get_ttl(),
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
        LOGGER.debug("CREATE CALL")
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
        query_string = print_ast(query)
        LOGGER.debug("appsync mutation response", extra=dict(query=query_string, response=response))
        return_value["successes"].append(response)
    except Exception as error:  # pylint: disable=broad-except
        return_value["errors"].append(error)

    return return_value

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

    response = await execute_gql_query_with_retries(
        query,
        client_session=appsync_session,
        logger=LOGGER,
    )

    query_string = print_ast(query)
    LOGGER.debug("appsync mutation response", extra=dict(query=query_string, response=response))

    return response

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
        ExpiresAfter=get_ttl(),
        EndTime=end_time,
        IsPartial=is_partial,
        SegmentId=segment_id,
        StartTime=start_time,
        Status="TRANSCRIBING",
        Transcript=transcript,
        OriginalTranscript=transcript,
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

        # Invoke custom lambda hook (if any) and use returned version of transcript_segment.
        if (TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN):
            transcript_segment = invoke_transcript_lambda_hook(transcript_segment)

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
                               isAlert=isAlert
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
    send_call_category_args = []
    tasks = []
    call_id = message["ContactId"]

    for segment in message.get("Segments", []):
        # only handle categories and transcripts with issues
        if (
            "Transcript" in segment and not segment["Transcript"].get("IssuesDetected")
        ) and "Categories" not in segment:
            continue

        categories = segment.get("Categories", {})
        for category in categories.get("MatchedCategories", []):
            category_details = categories["MatchedDetails"][category]
            category_segment = transform_segment_to_categories_agent_assist(
                category=category,
                category_details=category_details,
                call_id=call_id,
            )

            end_time = category_segment['StartTime'] + 0.1

            send_call_category_args.append(
                dict(
                    category=category_segment['Transcript'],
                    transcript_segment_args=dict(
                        CallId=message["CallId"],
                        Channel="CATEGORY_MATCH",
                        CreatedAt=category_segment["CreatedAt"],
                        EndTime=end_time,
                        ExpiresAfter=get_ttl(),
                        SegmentId=str(uuid.uuid4()),
                        StartTime=category_segment['StartTime'],
                        IsPartial=category_segment['IsPartial'],
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
        sns_task = publish_sns_category(
            sns_client=sns_client,
            category_name=category,
            call_id=message["CallId"]
        )
        tasks.append(sns_task)

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
        ExpiresAfter=get_ttl(),
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
    end_time = end_time + 0.001  # UI sort order

    return dict(
        CallId=call_id,
        Channel=channel,
        CreatedAt=created_at,
        ExpiresAfter=get_ttl(),
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
            end_time = end_time + 0.001  # UI sort order

            send_lex_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        EndTime=end_time,
                        ExpiresAfter=get_ttl(),
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
            end_time = end_time + 0.001  # UI sort order

            send_lex_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        EndTime=end_time,
                        ExpiresAfter=get_ttl(),
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
    call_id: str = message["ContactId"]
    channel: str = "AGENT_ASSISTANT"
    status: str = "TRANSCRIBING"
    is_partial: bool = False

    created_at: str
    start_time: float
    end_time: float

    send_lambda_agent_assist_args = []
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
            end_time = end_time + 0.001  # UI sort order

            send_lambda_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        ExpiresAfter=get_ttl(),
                        EndTime=end_time,
                        IsPartial=is_partial,
                        SegmentId=segment_id,
                        StartTime=start_time,
                        Status=status,
                    ),
                )
            )
        # BobS - Issue detection code will not be invoked since we are not processing
        # Transcript events now - only Utterance events - for latency reasons.
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
            end_time = end_time + 0.001  # UI sort order

            send_lambda_agent_assist_args.append(
                dict(
                    content=content,
                    transcript_segment_args=dict(
                        CallId=call_id,
                        Channel=channel,
                        CreatedAt=created_at,
                        ExpiresAfter=get_ttl(),
                        EndTime=end_time,
                        IsPartial=is_partial,
                        SegmentId=segment_id,
                        StartTime=start_time,
                        Status=status,
                    ),
                )
            )
        for issue in issues_detected:
            issue_segment = transform_segment_to_issues_agent_assist(
                segment={**segment, "CallId": call_id},
                issue=issue,
            )
            send_lambda_agent_assist_args.append(
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
            send_lambda_agent_assist_args.append(
                dict(
                    content=category_segment["Transcript"],
                    transcript_segment_args=category_segment,
                ),
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
# Agent Assist input uses the original (not modified) version of the
# "Transcript" field (note: this behavior is different for Transcribe/TCA 
# events)
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
# End of Call Lambda Hook
# User provided function 
##########################################################################

def invoke_end_of_call_lambda_hook(
    message: Dict[str, Any]
):
    LOGGER.debug("End of Call Lambda Hook Arn: %s", ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN)
    LOGGER.debug("End of Call Lambda Hook Request: %s", message)
    lambda_response = LAMBDA_HOOK_CLIENT.invoke(
        FunctionName=ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN,
        InvocationType='RequestResponse',
        Payload=json.dumps(message)
    )
    LOGGER.debug("End of Call Lambda Hook Response: ", extra=lambda_response)
    try:
        message = json.loads(lambda_response.get("Payload").read().decode("utf-8"))
    except Exception as error:
        LOGGER.error(
            "End of Call Lambda Hook result payload parsing exception. Lambda must return JSON object with (modified) input event fields",
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

    # maps from Contact Lens event status to LCA status
    event_type_map = dict(
        COMPLETED="ENDED", FAILED="ERRORED", SEGMENTS="TRANSCRIBING", STARTED="STARTED", UPDATE_AGENT="UPDATE_AGENT"
    )
    msg_event_type = message.get("EventType", "")
    event_type = event_type_map.get(msg_event_type, "")
    message_normalized = {**message, "EventType": event_type}

    if event_type == "TRANSCRIBING":

        add_transcript_tasks = add_transcript_segments(
            message=message_normalized,
            appsync_session=appsync_session,
        )

        add_call_category_tasks = add_call_category(
            message=message_normalized,
            appsync_session=appsync_session,
            sns_client=sns_client,
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

        add_lambda_agent_assists_tasks = []
        if IS_LAMBDA_AGENT_ASSIST_ENABLED:
            add_lambda_agent_assists_tasks.extend(
                add_lambda_agent_assistances(
                    message=message_normalized,
                    appsync_session=appsync_session,
                )
            )

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_call_category_tasks,
            *add_contact_lens_agent_assist_tasks,
            *add_lex_agent_assists_tasks,
            *add_lambda_agent_assists_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)

    elif event_type in ["STARTED", "ERRORED"]:
        return_value = await update_call_status(
            message=message_normalized,
            appsync_session=appsync_session,
        )
    elif event_type in ["ENDED"]:
        return_value = await update_call_status(
            message=message_normalized,
            appsync_session=appsync_session,
        )
        # UPDATE STATUS
        if (ENDOFCALL_LAMBDA_HOOK_FUNCTION_ARN):
            call_summary = invoke_end_of_call_lambda_hook(message)
            LOGGER.debug("Call summary: ")
            LOGGER.debug(call_summary)
            message['CallSummaryText'] = call_summary['summary']
            response = await execute_add_call_summary_text_mutation(
                message=message_normalized,
                appsync_session=appsync_session
            )

    elif event_type in ["UPDATE_AGENT"]:
        return_value = await execute_update_agent_mutation(
            message=message_normalized,
            appsync_session=appsync_session,
        )

    else:
        LOGGER.warning(
            "unknown event type [%s] (message event type [%s])", event_type, msg_event_type)

    return return_value
