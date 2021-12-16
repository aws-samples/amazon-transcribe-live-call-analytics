# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""DynamoDB Stream

Extends aws_lamba_powertools dynamo_db_stream utilities with type
deserialization. See:
https://github.com/awslabs/aws-lambda-powertools-python/blob/develop/aws_lambda_powertools/utilities/data_classes/dynamo_db_stream_event.py
"""

from typing import Any, Dict, Iterator, Optional
from boto3.dynamodb.types import TypeDeserializer

# pylint: disable=import-error
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import (
    DynamoDBRecord as _DynamoDBRecord,
    StreamRecord as _StreamRecord,
)

# pylint: enable=import-error


class StreamRecord(_StreamRecord):
    """Deserialized DynamoDB Stream Record"""

    def __init__(self, record: Dict[str, Any]):
        self._deserializer = TypeDeserializer()
        self._deserialized: Dict[str, Any] = {}
        super().__init__(record)

    def _deserialize(self, key):
        if key not in self._deserialized:
            self._deserialized[key] = {
                k: self._deserializer.deserialize(v) for k, v in self._data.get(key).items()
            }

        return self._deserialized[key]

    @property
    def keys(self) -> Optional[Dict[str, Any]]:
        """The primary key attribute(s) for the DynamoDB item that was modified."""
        return self._deserialize("Keys")

    @property
    def new_image(self) -> Optional[Dict[str, Any]]:
        """The item in the DynamoDB table as it appeared after it was modified."""
        return self._deserialize("NewImage")

    @property
    def old_image(self) -> Optional[Dict[str, Any]]:
        """The item in the DynamoDB table as it appeared before it was modified."""
        return self._deserialize("OldImage")


class DynamoDBRecord(_DynamoDBRecord):
    """Deserialized DynamoDB Record"""

    # pylint: disable=too-few-public-methods
    @property
    def dynamodb(self) -> Optional[StreamRecord]:
        """The main body of the stream record, containing all of the DynamoDB-specific fields."""
        stream_record = self.get("dynamodb")
        return None if stream_record is None else StreamRecord(stream_record)


class DynamoDBDeserializedStreamEvent:
    """Deserialized DynamoDB Stream Event
    Documentation:
    -------------
    - https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html
    - https://boto3.amazonaws.com/v1/documentation/api/latest/_modules/boto3/dynamodb/types.html
    """

    # pylint: disable=too-few-public-methods

    def __init__(self, event: Dict[str, Any]):
        self._event = event

    @property
    def records(self) -> Iterator[DynamoDBRecord]:
        """Deserialized record iterator"""
        for record in self._event["Records"]:
            yield DynamoDBRecord(record)
