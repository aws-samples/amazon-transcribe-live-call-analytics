#!/usr/bin/env python3.9
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from os import getenv
from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
import json
import re
import uuid

from datetime import datetime
from eventprocessor_utils import (
    get_ttl
)
from lex_utils import recognize_text_lex

# third-party imports from Lambda layer
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext
import boto3
from botocore.config import Config as BotoCoreConfig


# pylint: enable=import-error
LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")

if TYPE_CHECKING:
    from mypy_boto3_lambda.client import LambdaClient
    from mypy_boto3_kinesis.client import KinesisClient
    from mypy_boto3_lexv2_runtime.type_defs import RecognizeTextResponseTypeDef
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
    from boto3 import Session as Boto3Session
else:
    Boto3Session = object
    LambdaClient = object
    KinesisClient = object
    LexRuntimeV2Client = object
    RecognizeTextResponseTypeDef = object

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)

LAMBDA_CLIENT: LambdaClient = BOTO3_SESSION.client(
    "lambda",
    config=CLIENT_CONFIG,
)
KINESIS_CLIENT: KinesisClient = BOTO3_SESSION.client(
    "kinesis"
)

LEXV2_CLIENT: LexRuntimeV2Client = BOTO3_SESSION.client(
    "lexv2-runtime",
    config=CLIENT_CONFIG,
)

CALL_DATA_STREAM_NAME = getenv("CALL_DATA_STREAM_NAME", "")

LEX_BOT_ID = getenv("LEX_BOT_ID", "")
LEX_BOT_ALIAS_ID = getenv("LEX_BOT_ALIAS_ID", "")
LEX_BOT_LOCALE_ID = getenv("LEX_BOT_LOCALE_ID", "")

# def get_call_summary(
#     message: Dict[str, Any]
# ):
#     lambda_response = LAMBDA_CLIENT.invoke(
#         FunctionName=TRANSCRIPT_SUMMARY_FUNCTION_ARN,
#         InvocationType='RequestResponse',
#         Payload=json.dumps(message)
#     )
#     try:
#         message = json.loads(lambda_response.get("Payload").read().decode("utf-8"))
#     except Exception as error:
#         LOGGER.error(
#             "Transcript summary result payload parsing exception. Lambda must return JSON object with (modified) input event fields",
#             extra=error,
#         )
#     return message

def write_lex_agent_assist_to_kds(
    message: Dict[str, Any]
):
    callId = message.get("CallId", None)  
    message['EventType'] = "ADD_AGENT_ASSIST"

    if callId:
        try: 
            KINESIS_CLIENT.put_record(
                StreamName=CALL_DATA_STREAM_NAME,
                PartitionKey=callId,
                Data=json.dumps(message)
            )
            LOGGER.info("Write AGENT_ASSIST event to KDS")
        except Exception as error:
            LOGGER.error(
                "Error writing AGENT_ASSIST event to KDS ",
                extra=error,
            )
    return

def add_lex_agent_assistances(
    message: Dict[str, Any],
):
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
            **agent_assist_args,
        )
        tasks.append(task)

    return tasks

def send_lex_agent_assist(
    transcript_segment_args: Dict[str, Any],
    content: str,
):
    """Sends Lex Agent Assist Requests"""
    call_id = transcript_segment_args["CallId"]

    LOGGER.debug("Bot Request: %s", content)

    bot_response: RecognizeTextResponseTypeDef = recognize_text_lex(
        text=content,
        session_id=call_id,
        lex_client=LEXV2_CLIENT,
        bot_id=LEX_BOT_ID,
        bot_alias_id=LEX_BOT_ALIAS_ID,
        locale_id=LEX_BOT_LOCALE_ID,
    )

    LOGGER.debug("Bot Response: ", extra=bot_response)

    transcript_segment = {}
    transcript = get_lex_agent_assist_message(bot_response)
    if transcript:
        transcript_segment = {**transcript_segment_args, "Transcript": transcript}

    return transcript_segment

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

@LOGGER.inject_lambda_context
def handler(event, context: LambdaContext):
    # pylint: disable=unused-argument
    """Lambda handler"""
    LOGGER.debug("LEX agent assist lambda event", extra={"event": event})

    data = json.loads(json.dumps(event))

    transcripts = add_lex_agent_assistances(data)
    for transcript in transcripts:
        write_lex_agent_assist_to_kds(transcript)