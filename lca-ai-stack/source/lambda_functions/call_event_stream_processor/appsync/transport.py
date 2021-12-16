# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""AppSync GraphQL Async Transport"""
import json
from typing import Any, AsyncGenerator, Dict, Optional

from boto3 import Session as Boto3Session
from graphql import DocumentNode, ExecutionResult, print_ast
from gql.transport.aiohttp import AIOHTTPTransport

from .sigv4_request import get_sigv4_signed_request


class SigV4Values:
    """AppSync SigV4 Values"""

    # pylint: disable=too-few-public-methods
    method = "POST"
    service_name = "appsync"
    headers = {"Content-Type": "application/json"}


def _get_sigv4_signed_headers(
    url: str,
    boto3_session: Boto3Session,
    json_data: str,
    headers: Dict[str, Any],
):
    return get_sigv4_signed_request(
        method=SigV4Values.method,
        url=url,
        boto3_session=boto3_session,
        data=json_data,
        headers={**headers, **SigV4Values.headers},
        service_name=SigV4Values.service_name,
    ).headers


def _get_signed_request_data(
    document: DocumentNode,
    variable_values: Optional[Dict[str, Any]] = None,
) -> str:
    payload: Dict[str, Any] = dict(query=print_ast(document))
    if variable_values:
        payload["variables"] = variable_values

    data = json.dumps(payload)

    return data


class AIOAppSyncTransport(AIOHTTPTransport):
    """AppSync GraphQL Asynchronous AIOHTTP Transport

    It adds SigV4 headers to the AIOHTTPTransport of:
    https://github.com/graphql-python/gql
    """

    def __init__(
        self,
        url,
        boto3_session: Boto3Session,
        **kwargs,
    ) -> None:
        """
        :param url: AppSync GraphQL endpoint url
        :param boto3_session: Boto3 session used to obtain region and credentials
        """
        self._boto3_session = boto3_session
        super().__init__(url=url, **kwargs)

    async def execute(
        self,
        document: DocumentNode,
        variable_values: Optional[Dict[str, Any]] = None,
        operation_name: Optional[str] = None,
        extra_args: Optional[Dict[str, Any]] = None,
        upload_files: bool = False,
    ) -> ExecutionResult:
        # pylint: disable=too-many-arguments
        _extra_args = extra_args or {}
        headers = _extra_args.get("headers", {})

        json_data = _get_signed_request_data(document=document, variable_values=variable_values)
        signed_headers = _get_sigv4_signed_headers(
            url=self.url,
            boto3_session=self._boto3_session,
            json_data=json_data,
            headers=headers,
        )

        return await super().execute(
            document=document,
            variable_values=variable_values,
            operation_name=operation_name,
            upload_files=upload_files,
            extra_args={
                **_extra_args,
                "headers": signed_headers,
            },
        )

    # implement subscribe since it's a mandatory abstract method in the parent
    def subscribe(
        self,
        document: DocumentNode,
        variable_values: Optional[Dict[str, Any]] = None,
        operation_name: Optional[str] = None,
    ) -> AsyncGenerator[ExecutionResult, None]:
        """Subscribe is not supported on HTTP.
        :meta private:
        """
        raise NotImplementedError(" The HTTP transport does not support subscriptions")
