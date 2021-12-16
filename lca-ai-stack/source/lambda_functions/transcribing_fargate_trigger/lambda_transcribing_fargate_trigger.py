# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# type: ignore
"""
This Lambda is triggered by Chime Voice Connector EventBridge Events. It sends an Amazon SQS Message
with the stream details for an inbound call. The SQS message is consumed by the Fargate transcriber
"""
import json
import logging
import os
from decimal import Decimal

from datetime import timedelta
from dateutil import parser
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL"))

QUEUE_URL = os.getenv("QUEUE_URL")
EVENT_SOURCING_TABLE_NAME = os.getenv("EVENT_SOURCING_TABLE_NAME")
EXPIRATION_IN_DAYS = int(os.getenv("EXPIRATION_IN_DAYS", "90"))
ENABLE_TRANSCRIPTION = os.getenv("ENABLE_TRANSCRIPTION") == "true"
ENABLE_SAVE_RECORDING = os.getenv("ENABLE_SAVE_RECORDING") == "true"
LANGUAGE_CODE = os.getenv("LANGUAGE_CODE")

lambda_client = boto3.client("lambda")
dynamodb_client = boto3.resource("dynamodb")
sqs = boto3.resource("sqs").Queue(QUEUE_URL)

# https://docs.aws.amazon.com/chime/latest/ag/automating-chime-with-cloudwatch-events.html#stream-events-cvc
# maps incoming status event sourcing stream processor status
STREAM_STATUS_TO_EVENT_SOURCING = {
    "STARTED": "START",
    "ENDED": "END",
    "FAILED": "ERROR",
}


def lambda_handler(event, context):  # pylint: disable=unused-argument
    """Lambda Handler"""
    # pylint: disable=too-many-locals
    try:
        # Log the received event
        logger.info("Received event: %s", json.dumps(event))
        # Capture data from event
        # Use if SQS is the trigger: vc_event = json.loads(event.get('Records')[0].get('body'))
        vc_event = event
        call_id = vc_event["detail"]["callId"]
        transaction_id = vc_event["detail"]["transactionId"]
        stream_arn = vc_event["detail"]["streamArn"]
        stream_status = vc_event["detail"]["streamingStatus"]
        start_time = vc_event["detail"]["startTime"]
        fragment_start = vc_event["detail"]["startFragmentNumber"]

        # assumes incoming call from customer
        customer_phone_number = vc_event["detail"]["fromNumber"]
        system_phone_number = vc_event["detail"]["toNumber"]
        channel = "AGENT" if vc_event["detail"]["isCaller"] else "CALLER"

        # Store call details in the call events table
        event_type = STREAM_STATUS_TO_EVENT_SOURCING.get(stream_status, "UNKNOWN")
        start_time_datetime = parser.isoparse(start_time)
        expires_at = start_time_datetime + timedelta(days=EXPIRATION_IN_DAYS)

        event_sourcing_table = dynamodb_client.Table(EVENT_SOURCING_TABLE_NAME)
        item = {
            "PK": f"ce#{call_id}",
            "SK": f"ts#{start_time}#et#{event_type}#c#{channel}",
            "CallId": call_id,
            "ExpiresAfter": Decimal(expires_at.timestamp()),
            "CreatedAt": start_time,
            "CustomerPhoneNumber": customer_phone_number,
            "SystemPhoneNumber": system_phone_number,
            "Channel": channel,
            "EventType": event_type,
        }
        logger.info("call envent item: %s", item)
        table_response = event_sourcing_table.put_item(Item=item)

        logger.info("Updated event sourcing table: %s", json.dumps(table_response))

        if stream_status == "STARTED":
            # Send message to SQS for Fargate trigger
            payload = {
                "streamARN": stream_arn,
                "startFragmentNum": fragment_start,
                "channel": channel,
                "callId": call_id,
                "startTime": start_time,
                "transactionId": transaction_id,
                "transcriptionEnabled": ENABLE_TRANSCRIPTION,
                "saveCallRecording": ENABLE_SAVE_RECORDING,
                "languageCode": LANGUAGE_CODE,
            }
            logger.info("Sending Fargate trigger payload to SQS: %s", json.dumps(payload))
            sqs_response = sqs.send_message(MessageBody=json.dumps(payload))
            logger.info("Response from SQS: %s", json.dumps(sqs_response))

    except ClientError as error:
        logging.error(error)
        return {"lambdaResult": "Failed"}
    else:
        return {"lambdaResult": "Success"}
