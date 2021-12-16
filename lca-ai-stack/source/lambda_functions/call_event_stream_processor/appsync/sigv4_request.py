# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""SigV4 Request"""
from typing import Any, Dict, Optional
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from boto3 import Session


def get_sigv4_signed_request(
    method: str,
    url: str,
    boto3_session: Session,
    data: Optional[Any] = None,
    params: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, Any]] = None,
    service_name="execute-api",
) -> AWSRequest:
    """Builds an AWS SigV4 signed HTTP request"""
    # pylint: disable=too-many-arguments

    region_name = boto3_session.region_name
    credentials = boto3_session.get_credentials()
    frozen_credentials = credentials.get_frozen_credentials()
    request = AWSRequest(method=method, url=url, data=data, params=params, headers=headers)
    SigV4Auth(
        credentials=frozen_credentials,  # type: ignore
        service_name=service_name,
        region_name=region_name,
    ).add_auth(request)

    return request
