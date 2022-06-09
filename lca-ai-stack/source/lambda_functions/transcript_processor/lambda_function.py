#!/usr/bin/env python3.9
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
""" Transcription Passthrough Lambda Function
"""
import asyncio
from os import environ, getenv
from typing import TYPE_CHECKING, Dict, List

# third-party imports from Lambda layer
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext
import boto3
from botocore.config import Config as BotoCoreConfig

# imports from Lambda layer
# pylint: disable=import-error
from appsync_utils import AppsyncAioGqlClient
from transcript_batch_processor import TranscriptBatchProcessor

# local imports
from state_manager import TranscriptStateManager
from event_processor import execute_process_contact_lens_event_api_mutation
from event_processor import execute_process_transcribe_event_api_mutation

# pylint: enable=import-error

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import DynamoDBServiceResource, Table as DynamoDbTable
    from mypy_boto3_lexv2_runtime.client import LexRuntimeV2Client
    from boto3 import Session as Boto3Session
else:
    Boto3Session = object
    DynamoDBServiceResource = object
    DynamoDbTable = object
    LexRuntimeV2Client = object


APPSYNC_GRAPHQL_URL = environ["APPSYNC_GRAPHQL_URL"]
APPSYNC_CLIENT = AppsyncAioGqlClient(url=APPSYNC_GRAPHQL_URL, fetch_schema_from_transport=True)

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)

STATE_DYNAMODB_TABLE_NAME = environ["STATE_DYNAMODB_TABLE_NAME"]
STATE_DYNAMODB_RESOURCE: DynamoDBServiceResource = BOTO3_SESSION.resource(
    "dynamodb",
    config=CLIENT_CONFIG,
)
STATE_DYNAMODB_TABLE: DynamoDbTable = STATE_DYNAMODB_RESOURCE.Table(STATE_DYNAMODB_TABLE_NAME)

IS_LEX_AGENT_ASSIST_ENABLED = getenv("IS_LEX_AGENT_ASSIST_ENABLED", "true").lower() == "true"
if IS_LEX_AGENT_ASSIST_ENABLED:
    LEXV2_CLIENT: LexRuntimeV2Client = BOTO3_SESSION.client(
        "lexv2-runtime",
        config=CLIENT_CONFIG,
    )
LEX_BOT_ID = environ["LEX_BOT_ID"]
LEX_BOT_ALIAS_ID = environ["LEX_BOT_ALIAS_ID"]
LEX_BOT_LOCALE_ID = environ["LEX_BOT_LOCALE_ID"]

CALL_AUDIO_SOURCE = getenv("CALL_AUDIO_SOURCE")
MUTATION_FUNCTION_MAPPING = {
    "Demo Asterisk PBX Server": "execute_process_transcribe_event_api_mutation",
    "Chime Voice Connector (SIPREC)": "execute_process_transcribe_event_api_mutation",
    "Genesys Cloud Audiohook Web Socket": "execute_process_transcribe_event_api_mutation",
    "Amazon Connect Contact Lens": "execute_process_contact_lens_event_api_mutation"
}
MUTATION_FUNCTION_NAME = MUTATION_FUNCTION_MAPPING.get(CALL_AUDIO_SOURCE)

LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")

EVENT_LOOP = asyncio.get_event_loop()

async def update_state(event, event_processor_results) -> Dict[str, object]:
    """Updates the Lambda Tumbling Window State"""
    outgoing_state = event.get("state", {})
    async with TranscriptStateManager(
        event=event,
        appsync_client=APPSYNC_CLIENT,
        dynamodb_table=STATE_DYNAMODB_TABLE,
    ) as state_manager:
        for result in event_processor_results.get("successes", []):
            LOGGER.debug("event_processor result", extra=dict(result=result))
            # each result contains nested "successes" and "errors"
            # XXX refactor nested format to avoid confusion with event processor
            for item in result.get("successes", []):
                LOGGER.debug("event_processor item", extra=dict(result=result))
                if item:
                    updated_state = state_manager.update_state(input_item=item)
                    LOGGER.debug("updated state", extra=dict(updated_state=updated_state))

        outgoing_state = state_manager.state

    return outgoing_state


async def process_event(event) -> Dict[str, List]:
    """Processes a Batch of Transcript Records""" 
    async with TranscriptBatchProcessor(
        appsync_client=APPSYNC_CLIENT,
        agent_assist_args=dict(
            lex_client=LEXV2_CLIENT,
            lex_bot_id=LEX_BOT_ID,
            lex_bot_alias_id=LEX_BOT_ALIAS_ID,
            lex_bot_locale_id=LEX_BOT_LOCALE_ID,
        ),
        # called for each record right before the context manager exits
        api_mutation_fn=MUTATION_FUNCTION_NAME,
    ) as processor:
        await processor.handle_event(event=event)

    return processor.results


@LOGGER.inject_lambda_context
def handler(event, context: LambdaContext):
    # pylint: disable=unused-argument
    """Lambda handler"""
    LOGGER.debug("lambda event", extra={"event": event})

    event_processor_results = EVENT_LOOP.run_until_complete(process_event(event=event))
    LOGGER.debug("event processor results", extra=dict(event_results=event_processor_results))

    for error in event_processor_results.get("errors", []):
        LOGGER.error("event processor error: %s", error)
        if isinstance(error, Exception):
            try:
                raise error
            except Exception:  # pylint: disable=broad-except
                LOGGER.exception("event processor exception")

    # Lambda tumbling window state
    outgoing_state = EVENT_LOOP.run_until_complete(
        update_state(event=event, event_processor_results=event_processor_results),
    )

    # XXX set results metrics

    incoming_state = event.get("state", {})  # type: ignore
    LOGGER.debug("state", extra=dict(incoming_state=incoming_state, outgoing_state=outgoing_state))

    # XXX add failures to return value
    return {"state": outgoing_state}
