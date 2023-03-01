#!/usr/bin/env python3.9
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from os import environ, getenv
from typing import TYPE_CHECKING, Dict, List, Any
import json
import re

# third-party imports from Lambda layer
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext
import boto3
from botocore.config import Config as BotoCoreConfig

# pylint: enable=import-error
LOGGER = Logger(location="%(filename)s:%(lineno)d - %(funcName)s()")

if TYPE_CHECKING:
    from mypy_boto3_lambda.client import LambdaClient
    from boto3 import Session as Boto3Session
else:
    Boto3Session = object
    LambdaClient = object

BOTO3_SESSION: Boto3Session = boto3.Session()
CLIENT_CONFIG = BotoCoreConfig(
    retries={"mode": "adaptive", "max_attempts": 3},
)

LAMBDA_CLIENT: LambdaClient = BOTO3_SESSION.client(
    "lambda",
    config=CLIENT_CONFIG,
)
TRANSCRIPT_SUMMARY_FUNCTION_ARN = environ["TRANSCRIPT_SUMMARY_FUNCTION_ARN"]

def get_call_summary(
    message: Dict[str, Any]
):
    lambda_response = LAMBDA_CLIENT.invoke(
        FunctionName=TRANSCRIPT_SUMMARY_FUNCTION_ARN,
        InvocationType='RequestResponse',
        Payload=json.dumps(message)
    )
    try:
        message = json.loads(lambda_response.get("Payload").read().decode("utf-8"))
    except Exception as error:
        LOGGER.error(
            "Transcript summary result payload parsing exception. Lambda must return JSON object with (modified) input event fields",
            extra=error,
        )
    return message

def write_call_summary_to_kds(
    message: Dict[str, Any]
):
    
    


    return

@LOGGER.inject_lambda_context
def handler(event, context: LambdaContext):
    # pylint: disable=unused-argument
    """Lambda handler"""
    LOGGER.debug("Transcript summary lambda event", extra={"event": event})

    data = json.loads(json.dumps(event))

    call_summary = get_call_summary(message=data)

    LOGGER.debug("Call summary: ")
    LOGGER.debug(call_summary)
    data['CallSummaryText'] = call_summary['summary']

    write_call_summary_to_kds(data)
    
    return
