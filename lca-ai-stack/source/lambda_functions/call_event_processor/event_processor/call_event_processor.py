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
import boto3
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
from sns_utils import publish_sns
from lambda_utils import invoke_lambda
from eventprocessor_utils import (
    normalize_transcript_segments,
    get_ttl,
    transform_segment_to_add_sentiment,
    transform_segment_to_issues_agent_assist,
    transform_segment_to_categories_agent_assist,
)
# pylint: enable=import-error
if TYPE_CHECKING:
    from mypy_boto3_lambda.client import LambdaClient
    from mypy_boto3_lambda.type_defs import InvocationResponseTypeDef
    from mypy_boto3_sns.client import SNSClient
    from mypy_boto3_ssm.client import SSMClient
    from boto3 import Session as Boto3Session
else:
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

ASYNC_AGENT_ASSIST_ORCHESTRATOR_ARN = getenv("ASYNC_AGENT_ASSIST_ORCHESTRATOR_ARN", "")

TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY = getenv(
    "TRANSCRIPT_LAMBDA_HOOK_FUNCTION_NONPARTIAL_ONLY", "true").lower() == "true"
if TRANSCRIPT_LAMBDA_HOOK_FUNCTION_ARN or ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN or ASYNC_AGENT_ASSIST_ORCHESTRATOR_ARN:
    LAMBDA_HOOK_CLIENT: LambdaClient = BOTO3_SESSION.client("lambda", config=CLIENT_CONFIG)

IS_LEX_AGENT_ASSIST_ENABLED = False

IS_LAMBDA_AGENT_ASSIST_ENABLED = False

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
DEFAULT_SYSTEM_PHONE_NUMBER = getenv("DEFAULT_SYSTEM_PHONE_NUMBER", "+18005551111")
CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER = getenv(
    "CONNECT_CONTACT_ATTR_CUSTOMER_PHONE_NUMBER", "LCA Caller Phone Number")
CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER = getenv(
    "CONNECT_CONTACT_ATTR_SYSTEM_PHONE_NUMBER", "LCA System Phone Number")

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

    # Contact Lens STARTED event type doesn't provide customer and system phone numbers, nor does it
    # have CreatedAt, so we will create a new message structure that conforms to other KDS channels.

    if('ContactId' in message.keys()):
        call_id = message.get("ContactId")
        created_at = datetime.utcnow().astimezone().isoformat()
        instanceId = message.get("InstanceId")
        contactId = message.get("ContactId")
        (customer_phone_number, system_phone_number) = get_caller_and_system_phone_numbers_from_connect(
            instanceId, contactId)
        message = dict (
            CallId=call_id,
            CreatedAt=created_at,
            ExpiresAfter=get_ttl(),
            CustomerPhoneNumber=customer_phone_number,
            SystemPhoneNumber=system_phone_number,
        )

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

    # Contact Lens event requires CallId mapped to ContactId

    if('ContactId' in message.keys()):
        call_id = message.get("ContactId")
        updated_at = datetime.utcnow().astimezone().isoformat()
        message['CallId'] = call_id
        message['UpdatedAt'] = updated_at

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

async def execute_add_agent_assist_mutation(
    message: Dict[str, Any],
    appsync_session: AppsyncAsyncClientSession,
) -> Dict:

    if not appsync_session.client.schema:
        raise ValueError("invalid AppSync schema")
    schema = DSLSchema(appsync_session.client.schema)

    LOGGER.debug("Add Agent Assist Mutation message: %s", json.dumps(message))
    query = dsl_gql(
        DSLMutation(
            schema.Mutation.addTranscriptSegment.args(input=message).select(
                *transcript_segment_fields(schema),
            )
        )
    )

    LOGGER.debug("Executing QUERY: %s", query)


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

def add_contact_lens_call_category(
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
    global IS_LEX_AGENT_ASSIST_ENABLED
    global IS_LAMBDA_AGENT_ASSIST_ENABLED
    global SETTINGS
    # pylint: enable=global-statement

    IS_LEX_AGENT_ASSIST_ENABLED = agent_assist_args.get("is_lex_agent_assist_enabled")
    IS_LAMBDA_AGENT_ASSIST_ENABLED = agent_assist_args.get("is_lambda_agent_assist_enabled")
    SETTINGS = settings

    return_value: Dict[Literal["successes", "errors"], List] = {
        "successes": [],
        "errors": [],
    }

    event_type_map = dict(
        STARTED="START",
        START="START",
        COMPLETED="END",
        END="END",
        SEGMENTS="ADD_TRANSCRIPT_SEGMENT",
        ADD_TRANSCRIPT_SEGMENT="ADD_TRANSCRIPT_SEGMENT",
        FAILED="ERRORED",
        UPDATE_AGENT="UPDATE_AGENT",
        ADD_SUMMARY="ADD_SUMMARY",
        ADD_AGENT_ASSIST="ADD_AGENT_ASSIST",
        ADD_CALL_CATEGORY="ADD_CALL_CATEGORY",
        ADD_S3_RECORDING_URL="ADD_S3_RECORDING_URL",
        ADD_PCA_URL="ADD_PCA_URL",
    )

    msg_event_type = message.get("EventType", "")
    event_type = event_type_map.get(msg_event_type, "")

    message["EventType"] = event_type
    message["ExpiresAfter"] = get_ttl()

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
        
        if (IS_TRANSCRIPT_SUMMARY_ENABLED):
            LAMBDA_HOOK_CLIENT.invoke(
                FunctionName=ASYNC_TRANSCRIPT_SUMMARY_ORCHESTRATOR_ARN,
                InvocationType='Event',
                Payload=json.dumps(message)
            )
            LOGGER.debug("END Event: Invoked Async Transcript Summary Lambda")
      
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

    elif event_type == "ADD_AGENT_ASSIST":
        LOGGER.debug("ADD_AGENT_ASSIST MUTATION ")
        normalized_message = normalize_transcript_segments({**message})

        response = await execute_add_agent_assist_mutation(
            message=normalized_message[0],
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

        normalized_messages = normalize_transcript_segments({**message})

        add_transcript_tasks = []
        add_transcript_sentiment_tasks = []

        for normalized_message in normalized_messages:
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

            LOGGER.debug("Add Transcript Segment")
            add_transcript_tasks.extend(
                add_transcript_segments(
                    message=normalized_message,
                    appsync_session=appsync_session,
                )
            )
            if IS_SENTIMENT_ANALYSIS_ENABLED and not normalized_message["IsPartial"]:
                LOGGER.debug("Add Sentiment Analysis")
                add_transcript_sentiment_tasks.extend(
                    add_transcript_sentiment_analysis(
                        message=normalized_message,
                        sentiment_analysis_args=sentiment_analysis_args,
                        appsync_session=appsync_session,
                    )
                )
            if (IS_LEX_AGENT_ASSIST_ENABLED or IS_LAMBDA_AGENT_ASSIST_ENABLED) and (normalized_message["Channel"] == "CALLER" and (not normalized_message["IsPartial"] or 'ContactId' in normalized_message.keys())):
                LAMBDA_HOOK_CLIENT.invoke(
                    FunctionName=ASYNC_AGENT_ASSIST_ORCHESTRATOR_ARN,
                    InvocationType='Event',
                    Payload=json.dumps(normalized_message)
                )

        add_call_category_tasks = []
        add_contact_lens_agent_assist_tasks = []

        if 'ContactId' in message.keys():
            add_call_category_tasks = add_contact_lens_call_category(
                message=message,
                appsync_session=appsync_session,
                sns_client=sns_client,
            )

            add_contact_lens_agent_assist_tasks = add_contact_lens_agent_assistances(
                message=message,
                appsync_session=appsync_session,
            )

        task_responses = await asyncio.gather(
            *add_transcript_tasks,
            *add_transcript_sentiment_tasks,
            *add_call_category_tasks,
            *add_contact_lens_agent_assist_tasks,
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
