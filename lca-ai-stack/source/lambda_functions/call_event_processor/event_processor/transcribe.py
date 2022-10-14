# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Transcribe API Mutation Processor
"""
import asyncio
from datetime import datetime
from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
import uuid
import json

# third-party imports from Lambda layer
from botocore.config import Config as BotoCoreConfig
from aws_lambda_powertools import Logger
from gql.client import AsyncClientSession as AppsyncAsyncClientSession
from gql.dsl import DSLMutation, DSLSchema, dsl_gql
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
    from mypy_boto3_lambda.type_defs import InvocationResponseTypeDef
else:
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object
    InvocationResponseTypeDef = object


IS_SENTIMENT_ANALYSIS_ENABLED = getenv("IS_SENTIMENT_ANALYSIS_ENABLED", "true").lower() == "true"

IS_LEX_AGENT_ASSIST_ENABLED = False
LEXV2_CLIENT: Optional[LexRuntimeV2Client] = None
LEX_BOT_ID: str
LEX_BOT_ALIAS_ID: str
LEX_BOT_LOCALE_ID: str

IS_LAMBDA_AGENT_ASSIST_ENABLED = False
LAMBDA_CLIENT: Optional[LexRuntimeV2Client] = None
LAMBDA_AGENT_ASSIST_FUNCTION_ARN: str

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
        ignore_exception_fn = lambda e: True if (e["message"] == 'item put condition failure') else False
        tasks.append(
            execute_gql_query_with_retries(
                query,
                client_session=appsync_session,
                logger=LOGGER,
                should_ignore_exception_fn = ignore_exception_fn, 
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
    
    result = await execute_gql_query_with_retries(
                        query,
                        client_session=appsync_session,
                        logger=LOGGER,
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
    appsync_session: AppsyncAsyncClientSession,
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

def add_call_category(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> List[Coroutine]:
    """Add Categories GraphQL Mutations"""
    # pylint: disable=too-many-locals
    LOGGER.debug("Detected Call Category")

    category = message["CategoryEvent"]["MatchedCategories"][0]
    start_time = message["CategoryEvent"]["MatchedDetails"][category]["TimestampRanges"][0]["EndOffsetMillis"]/1000
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

    tasks = []
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
    appContextJSON = bot_response.get("sessionState",{}).get("sessionAttributes",{}).get("appContext")
    if appContextJSON:
        appContext = json.loads(appContextJSON)
        markdown = appContext.get("altMessages",{}).get("markdown")
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

    send_lex_agent_assist_args = []
    if (message["Channel"] == "CALLER" and not message["IsPartial"]):
        send_lex_agent_assist_args.append(
                dict(
                    content=message["Transcript"],
                    transcript_segment_args=dict(
                        CallId=message["CallId"],
                        Channel="AGENT_ASSISTANT",
                        CreatedAt=message["CreatedAt"],
                        EndTime=message["EndTime"],
                        ExpiresAfter=get_ttl(),
                        IsPartial=message["IsPartial"],
                        SegmentId=str(uuid.uuid4()),
                        StartTime=message["StartTime"],
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
        'transcript_segment_args': transcript_segment_args
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

    send_lambda_agent_assist_args = []
    if (message["Channel"] == "CALLER" and not message["IsPartial"]):
        send_lambda_agent_assist_args.append(
                dict(
                    content=message["Transcript"],
                    transcript_segment_args=dict(
                        CallId=message["CallId"],
                        Channel="AGENT_ASSISTANT",
                        CreatedAt=message["CreatedAt"],
                        EndTime=message["EndTime"],
                        ExpiresAfter=get_ttl(),
                        IsPartial=message["IsPartial"],
                        SegmentId=str(uuid.uuid4()),
                        StartTime=message["StartTime"],
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
    
async def execute_process_event_api_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
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
    # pylint: enable=global-statement

    LEXV2_CLIENT = agent_assist_args.get("lex_client")
    IS_LEX_AGENT_ASSIST_ENABLED = LEXV2_CLIENT is not None
    LEX_BOT_ID = agent_assist_args.get("lex_bot_id", "")
    LEX_BOT_ALIAS_ID = agent_assist_args.get("lex_bot_alias_id", "")
    LEX_BOT_LOCALE_ID = agent_assist_args.get("lex_bot_locale_id", "")
    LAMBDA_CLIENT = agent_assist_args.get("lambda_client")
    IS_LAMBDA_AGENT_ASSIST_ENABLED = LAMBDA_CLIENT is not None
    LAMBDA_AGENT_ASSIST_FUNCTION_ARN = agent_assist_args.get("lambda_agent_assist_function_arn", "")   

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
        "ADD_CHANNEL_S3_RECORDING_URL",]:
        # UPDATE STATUS
        LOGGER.debug("update status")
        response = await execute_update_call_status_mutation(
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

        normalized_message = {
            **normalize_transcript_segment({**message}),
        }
        
        LOGGER.debug("Add Transcript Segment")
        add_transcript_tasks = add_transcript_segments(
            message=normalized_message,
            appsync_session=appsync_session,
        )

        add_transcript_sentiment_tasks = []
        if IS_SENTIMENT_ANALYSIS_ENABLED and not normalized_message["IsPartial"]:
            LOGGER.debug("Add Sentiment Analysis")
            add_transcript_sentiment_tasks = add_transcript_sentiment_analysis(
                message=normalized_message,
                sentiment_analysis_args=sentiment_analysis_args,
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

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_transcript_sentiment_tasks,
            *add_lex_agent_assists_tasks,
            *add_lambda_agent_assists_tasks,
            #*add_tca_agent_assist_tasks,
            return_exceptions=True,
        )

        for response in task_responses:
            if isinstance(response, Exception):
                return_value["errors"].append(response)
            else:
                return_value["successes"].append(response)

    elif event_type == "ADD_CALL_CATEGORY":
        add_call_category_tasks = []
        add_call_category_tasks = add_call_category(
            message=message,
            appsync_session=appsync_session,
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
