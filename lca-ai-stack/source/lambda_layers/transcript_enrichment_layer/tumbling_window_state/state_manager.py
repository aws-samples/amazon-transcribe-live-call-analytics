# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Lambda Tumbling Window State Manager"""
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
import json
import traceback
from typing import TYPE_CHECKING, Any, Dict, Final, Generator, Mapping, Tuple, TypedDict
import zlib

from aws_lambda_powertools import Logger
from boto3.dynamodb.conditions import Key


if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table as DynamoDbTable
    from mypy_boto3_dynamodb.type_defs import QueryInputTableTypeDef
else:
    DynamoDbTable = object
    QueryInputTableTypeDef = object

LOGGER = Logger(child=True, location="%(filename)s:%(lineno)d - %(funcName)s()")


class DynamoDbConfig(TypedDict):
    """DynamoDb State Configuration"""

    pk_name: str
    pk_value: str
    sk_name: str
    state_attr: str
    ttl_attr: str
    ttl_value_in_days: int


class StateManager(ABC):
    """Lambda Tumbling Window State Manager Base Class

    https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html#services-ddb-windows

    Implements a Python Context Manager used to persist and restore the state
    in DynamoDB when a tumbling window is terminated.

    Persists the state as JSON in DynamoDB. Uses a single Partition Key and a
    Sort Key based on a timestamp to store the state. This allows concurrent
    Lambda functions to persist their current state.
    The state is restored by querying DynamoDB using the Sort Key to find state
    that are less than the expiration of the tumbling window relative from the
    current time. The state is rehydrated by merging the items from DynamoDB
    in the order of most recent.

    Conditionally compresses the state in DynamoDB if the payload is larger than
    100KB. This reduces the risk of hitting the DynamoDB item limit
    (400K) and reduces network transfer time
    """

    DEFAULT_MAX_WINDOW_IN_SECS: Final[int] = 900
    DEFAULT_DYNAMODB_PK_NAME: Final[str] = "PK"
    DEFAULT_DYNAMODB_SK_NAME: Final[str] = "SK"
    DEFAULT_DYNAMODB_PK_VALUE: Final[str] = "LambdaTumblingWindowState"
    DEFAULT_DYNAMODB_STATE_ATTR: Final[str] = "State"
    DEFAULT_DYNAMODB_TTL_ATTR: Final[str] = "ExpiresAfter"
    DEFAULT_DYNAMODB_TTL_VALUE_IN_DAYS: Final[int] = 1

    MAX_DYNAMODB_JSON_SIZE: Final[int] = 100 * 1024

    def __init__(
        self,
        event: Dict[str, Any],
        dynamodb_table: DynamoDbTable,
        max_window_in_secs: int = DEFAULT_MAX_WINDOW_IN_SECS,
        **kwargs,
    ) -> None:
        """
        Creates a Python context manager that is used to persist and restore the
        Lambda tumbling window state in DynamoDB.

        :param event: Lambda event
        :param dynamodb_table: boto3 DynamoDb Table resource
        :param max_window_in_secs: Maximum time window to use for restoring the
          state from DynamoDb.

        kwargs:
        :param dynamodb_pk_name: DynamoDB partition key name
        :param dynamodb_pk_value: DynamoDB partition key value
        :param dynamodb_sk_name: DynamoDB sort key name
        :param dynamodb_state_attr: DynamoDB state attribute
        :param dynamodb_ttl_attr: DynamoDB TTL attribute
        :param dynamodb_ttl_value_in_days: DynamoDB TTL value in days
        """
        self._event = event
        # TODO  pylint: disable=fixme
        # conditionally support base64 compressed serialization to reduce the risk of hitting the
        # Lambda 1MB tumbling window limit
        self._max_window_in_secs = max_window_in_secs

        self._dynamodb_table = dynamodb_table
        self._ddb_config = DynamoDbConfig(
            pk_name=kwargs.get("dynamodb_pk_name", self.DEFAULT_DYNAMODB_PK_NAME),
            pk_value=kwargs.get("dynamodb_pk_value", self.DEFAULT_DYNAMODB_PK_VALUE),
            sk_name=kwargs.get("dynamodb_sk_name", self.DEFAULT_DYNAMODB_SK_NAME),
            state_attr=kwargs.get("dynamodb_state_attr", self.DEFAULT_DYNAMODB_STATE_ATTR),
            ttl_attr=kwargs.get("dynamodb_ttl_attr", self.DEFAULT_DYNAMODB_TTL_ATTR),
            ttl_value_in_days=kwargs.get(
                "dynamodb_ttl_value_in_days",
                self.DEFAULT_DYNAMODB_TTL_VALUE_IN_DAYS,
            ),
        )

        self._has_error: bool = False
        self._state: Mapping[str, object] = event.get("state", {})
        self._is_initial_state: bool = bool(not self._state)

    async def __aenter__(self):
        if self._is_initial_state:
            LOGGER.debug("restoring tumbling window state")
            self._restore_state()

        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if exc_type or exc_val or exc_tb:
            LOGGER.error(
                "tumbling window error: %s, %s, %s",
                exc_type,
                exc_val,
                traceback.format_tb(exc_tb),
            )
            self._has_error = True
        try:
            if self._state and (
                self._event.get("isFinalInvokeForWindow")
                or self._event.get("isWindowTerminatedEarly")
            ):
                if self._event.get("isWindowTerminatedEarly"):
                    LOGGER.warning("tumbling window terminated early")

                LOGGER.debug("persisting tumbling window state")
                self._persist_state()
        except Exception as exception:  # pylint: disable=broad-except
            self._has_error = True
            LOGGER.exception("tumbling window state manager exception: %s", exception)

        return True

    def _get_persisted_state_items_generator(self) -> Generator[Mapping[str, object], None, None]:
        # TODO  pylint: disable=fixme
        # change this to an async generator

        # get time delta based on the max window size
        max_window_delta_timestamp = (
            datetime.utcnow() - timedelta(seconds=self._max_window_in_secs)
        ).isoformat()
        # key expression with a sort key greater than the window size
        key_condition_expression = Key(self._ddb_config["pk_name"]).eq(
            self._ddb_config["pk_value"]
        ) & Key(self._ddb_config["sk_name"]).gt(max_window_delta_timestamp)
        query_args: QueryInputTableTypeDef = dict(
            KeyConditionExpression=key_condition_expression,
            # scan index in reverse order since we want to return the most
            # recent items on top
            ScanIndexForward=False,
            # use consistent reads to improve chances getting state concurrently being written
            ConsistentRead=True,
        )
        response = self._dynamodb_table.query(**query_args)
        LOGGER.debug("tumbling window restore query response", extra=dict(response=response))
        for item in response.get("Items", []):
            state = item.get(self._ddb_config["state_attr"], "")
            if state and isinstance(state, str):
                yield json.loads(state)
            # state larger than MAX_DYNAMODB_JSON_SIZE are stored zlib compressed
            if state and isinstance(state, bytes):
                yield json.loads(zlib.decompress(state).decode("utf-8"))

        # paginate through responses
        while "LastEvaluatedKey" in response:
            query_args["ExclusiveStartKey"] = response["LastEvaluatedKey"]
            response = self._dynamodb_table.query(**query_args)

            LOGGER.debug(
                "tumbling window restore paginated query response",
                extra=dict(response=response),
            )
            for item in response.get("Items", []):
                state_json = item.get(self._ddb_config["state_attr"], "")
                if state_json and isinstance(state_json, str):
                    yield json.loads(state_json)

    def _get_merge_state_tuple_generator(
        self,
        previous_state: Mapping[str, object],
        new_state: Mapping[str, object],
    ) -> Generator[Tuple[str, object], None, None]:
        """Generator to recursively merge two dictionaries

        Values from new_state overrides previous_state.
        Concatenates list entries.
        Yields tuples of the merged dictionary key/value pairs
        """
        for k in set(previous_state).union(set(new_state)):
            if k in previous_state and k in new_state:
                previous_state_val = previous_state[k]
                new_state_val = new_state[k]
                # recursively merge dictionaries
                if isinstance(previous_state_val, dict) and isinstance(new_state_val, dict):
                    yield (
                        k,
                        dict(
                            self._get_merge_state_tuple_generator(
                                previous_state_val,
                                new_state_val,
                            ),
                        ),
                    )
                # merge list values - may contain duplicates which should be later deduplicated
                # and/or merged by the concrete class
                elif isinstance(previous_state_val, list) and isinstance(new_state_val, list):
                    yield (k, [*previous_state_val, *new_state_val])
                # values are overriden by new state
                else:
                    yield (k, new_state[k])
            # key only in previous state
            elif k in previous_state:
                yield (k, previous_state[k])
            # key only in new state
            else:
                yield (k, new_state[k])

    def _restore_state(self) -> None:
        items = list(self._get_persisted_state_items_generator())
        if not items:
            LOGGER.debug("tumbling window restore empty")
            return

        LOGGER.debug("tumbling window restore items", extra=dict(items=items))

        state: Mapping[str, object] = {}
        for item in items:
            LOGGER.debug("tumbling window item to merge", extra=dict(item=item))
            state = dict(
                self._get_merge_state_tuple_generator(previous_state=state, new_state=item),
            )
            LOGGER.debug("tumbling window partial merged state", extra=dict(state=state))

        LOGGER.debug("tumbling window restore state rehydrated", extra=dict(state=state))
        self._state = state

    def _persist_state(self) -> None:
        # TODO  pylint: disable=fixme
        # change this to async

        now = datetime.utcnow()
        now_timestamp = now.isoformat()
        expires_at = int(
            (now + timedelta(days=int(self._ddb_config["ttl_value_in_days"]))).timestamp()
        )

        state_json = json.dumps(self._state)
        # conditionally compresses the state to reduce the chance of hitting dynamoDB limit 400K
        state = (
            state_json
            if len(state_json) < self.MAX_DYNAMODB_JSON_SIZE
            else zlib.compress(state_json.encode("utf-8"))
        )

        item: Mapping[str, Any] = {
            self._ddb_config["pk_name"]: self._ddb_config["pk_value"],
            self._ddb_config["sk_name"]: now_timestamp,
            self._ddb_config["state_attr"]: state,
            self._ddb_config["ttl_attr"]: expires_at,
        }
        LOGGER.debug("tumbling window persist item", extra=dict(item=item))
        response = self._dynamodb_table.put_item(Item=item, ReturnValues="ALL_OLD")
        LOGGER.debug("tumbling window persist response", extra=dict(response=response))

    @abstractmethod
    def update_state(self, input_item: Any) -> Mapping[str, object]:
        """Updates the state from an input item

        Should be implemented to deep merge and deduplicate the input item into
        the existing state

        Returns the updated state
        """
        return self._state

    @property
    def state(self) -> Mapping[str, object]:
        """State"""
        return self._state

    @property
    def has_error(self) -> bool:
        """Indicates if an exception occurred in the context manager"""
        return self._has_error
