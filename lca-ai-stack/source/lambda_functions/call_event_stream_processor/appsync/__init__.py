# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""AppSync GraphQL Async IO Transport"""
from .execute_query import execute_gql_query_with_retries

__all__ = ["execute_gql_query_with_retries"]
