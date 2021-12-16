# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# type: ignore
"""
Lambda function to receive an S3 object create notification, and use the
call ID in the filename to determine if 2 mono files exist. If they do,
this function uses the pydub library to merge those audio files.
"""
import os
import json
import logging
from tempfile import NamedTemporaryFile
from datetime import datetime, timedelta
import boto3
from botocore.client import Config
from pydub import AudioSegment  # pylint: disable=import-error

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client("s3", config=Config(signature_version="s3v4"))
dynamodb_client = boto3.resource("dynamodb")
event_sourcing_table = dynamodb_client.Table(os.environ.get("EVENT_SOURCING_TABLE_NAME"))
output_bucket = os.environ.get("OUTPUT_BUCKET")
ddb_expiration = os.environ.get("EXPIRATION_IN_DAYS")
mono_recording_prefix = os.environ.get("MONO_RECORDING_FILE_PREFIX")
recording_file_prefix = os.environ.get("RECORDING_FILE_PREFIX") or "lca-call-audio-recordings"
aws_region = os.environ.get("AWS_REGION")


def lambda_handler(event, context):  # pylint: disable=unused-argument
    """Lambda handler"""
    # pylint: disable=too-many-locals
    logger.info("Processing audio merge request event >>>")
    logger.info(event)
    try:
        for s3event in event["Records"]:
            event_body = json.loads(s3event["body"])
            if event_body.get("Records") is None:
                logger.info("Skipping unexpected record:")
                logger.info(event_body)
                continue
            for record in event_body["Records"]:
                recording_bucket = record.get("s3", {}).get("bucket", {}).get("name", {})
                call_id = (
                    record.get("s3", {})
                    .get("object", {})
                    .get("key", {})
                    .rsplit("/", 2)[1]
                    .rsplit("_", 2)[0]
                )
                channel = (
                    record.get("s3", {})
                    .get("object", {})
                    .get("key", {})
                    .rsplit("/", 2)[1]
                    .rsplit("_", 2)[1]
                )
                agent_recording_key = s3_client.list_objects_v2(
                    Bucket=recording_bucket, Prefix=f"{mono_recording_prefix}{call_id}_AGENT"
                )
                customer_recording_key = s3_client.list_objects_v2(
                    Bucket=recording_bucket, Prefix=f"{mono_recording_prefix}{call_id}_CALLER"
                )

                # Check if both recordings exist, and skip processing if missing
                if (
                    customer_recording_key.get("KeyCount") == 0
                    or agent_recording_key.get("KeyCount") == 0
                ):
                    message = "Skipping merge operation since both files are not available yet."
                    logger.info(message)
                    continue

                # Download recordings
                customer_recording = s3_client.get_object(
                    Bucket=recording_bucket,
                    Key=customer_recording_key.get("Contents")[0].get("Key"),
                )
                agent_recording = s3_client.get_object(
                    Bucket=recording_bucket, Key=agent_recording_key.get("Contents")[0].get("Key")
                )

                # Set up output paths
                output_key = recording_file_prefix + call_id + ".wav"

                # Extract audio segments
                customer_segment = AudioSegment(
                    customer_recording["Body"].read(), sample_width=2, frame_rate=8000, channels=1
                )
                agent_segment = AudioSegment(
                    agent_recording["Body"].read(), sample_width=2, frame_rate=8000, channels=1
                )

                # If lengths don't match, then account for silence
                l_channel, r_channel = (
                    (customer_segment, agent_segment)
                    if customer_segment.duration_seconds > agent_segment.duration_seconds
                    else (agent_segment, customer_segment)
                )
                silent_segment = AudioSegment.silent(
                    (l_channel.frame_count() - r_channel.frame_count()) / 8, frame_rate=8000
                )
                r_channel_padded = silent_segment.append(r_channel, crossfade=0)

                # Create stereo segment
                stereo_sound = AudioSegment.from_mono_audiosegments(l_channel, r_channel_padded)
                with NamedTemporaryFile() as output_handle:
                    stereo_sound.export(output_handle.name, format="wav")
                    # Upload stereo audio to output bucket
                    s3_client.upload_file(
                        output_handle.name,
                        output_bucket,
                        output_key,
                        ExtraArgs={"ContentType": "audio/wav"},
                    )
                logger.info(
                    "Successfully saved merged audio to the S3 bucket %s for Call Id %s",
                    output_bucket,
                    call_id,
                )

                # Update event source table with channel recording
                update_event_source(call_id, channel, output_key)

        return "Successfully completed mono to stereo processing"
    except Exception as error:
        logger.error("Exception occurred: ")
        logger.error(error)
        raise error


def update_event_source(call_id, channel, output_key):
    """Sends the add s3 recording URL event"""
    try:
        event_type = "ADD_CHANNEL_S3_RECORDING_URL"
        start_time = int(datetime.now().timestamp())
        expires_at = int((datetime.now() + timedelta(days=int(ddb_expiration))).timestamp())

        # Generate S3 URL
        recording_url = f"https://s3-{aws_region}.amazonaws.com/{output_bucket}/{output_key}"

        item = {
            "PK": f"ce#{call_id}",
            "SK": f"ts#{start_time}#et#{event_type}#c#{channel}",
            "CallId": call_id,
            "ExpiresAfter": expires_at,
            "CreatedAt": start_time,
            "Channel": channel,
            "RecordingUrl": recording_url,
            "EventType": event_type,
        }
        logger.info("channel audio event item: %s", item)
        table_response = event_sourcing_table.put_item(Item=item)

        logger.info("Updated event sourcing table: %s", json.dumps(table_response))
    except Exception as error:
        logger.error("Exception occurred: ")
        logger.error(error)
        raise error
