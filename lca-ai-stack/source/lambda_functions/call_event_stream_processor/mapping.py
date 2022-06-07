# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DynamoDB Mappings"""
from typing import Dict

# third-party imports from Lambda layer
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import (
    DynamoDBRecordEventName,
)

# local imports
# pylint: disable=import-error
from dynamodb_stream_event import DynamoDBRecord

# pylint: enable=import-error

PK_ATTRIBUTE = "PK"
SK_ATTRIBUTE = "SK"

FACET_SEPARATOR = "#"

CALL_EVENT_RECORD_PK_PREFIX = f"ce{FACET_SEPARATOR}"

CALL_EVENT_TYPE_TO_STATUS = {
    "START": "STARTED",
    "START_TRANSCRIPT": "TRANSCRIBING",
    "CONTINUE_TRANSCRIPT": "TRANSCRIBING",
    "CONTINUE": "TRANSCRIBING",
    "END_TRANSCRIPT": "ENDED",
    "TRANSCRIPT_ERROR": "ERRORED ",
    "ERROR": "ERRORED ",
    "END": "ENDED",
    "ADD_CHANNEL_S3_RECORDING_URL": "ENDED",
    "ADD_S3_RECORDING_URL": "ENDED",
}


def is_call_event_record(record: DynamoDBRecord) -> bool:
    """Checks if a dynamoDB Stream record is a call event record"""
    return record.event_name == DynamoDBRecordEventName.INSERT and record.dynamodb.keys[
        PK_ATTRIBUTE
    ].startswith(CALL_EVENT_RECORD_PK_PREFIX)


def is_call_create(item: Dict) -> bool:
    """Checks if a dynamoDB Stream item is a call status create event"""
    return item.get("EventType") == "START"


def is_call_status_update(item: Dict) -> bool:
    """Checks if a dynamoDB Stream item is a call status update event"""
    return item.get("EventType") in [
        "START_TRANSCRIPT",
        "CONTINUE_TRANSCRIPT",
        "CONTINUE",
        "END_TRANSCRIPT",
        "TRANSCRIPT_ERROR",
        "ERROR",
        "END",
        "ADD_CHANNEL_S3_RECORDING_URL",
    ]


def is_transcript_segment_add(item: Dict) -> bool:
    """Checks if a dynamoDB Stream item is a transcript update event"""
    return item.get("EventType") == "ADD_TRANSCRIPT_SEGMENT"


def is_s3_recording_add(item: Dict) -> bool:
    """Checks if a dynamoDB Stream item is an add S3 recording event"""
    return item.get("EventType") == "ADD_S3_RECORDING_URL"
