# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Call State Model

Tries to use a schema and field names similar to the Transcribe Call Analytics
output format when possible
https://docs.aws.amazon.com/transcribe/latest/dg/call-analytics-output.html
https://docs.aws.amazon.com/transcribe/latest/dg/call-analytics-sentiment.html
"""
from typing import Dict, List, Literal, TypedDict


SentimentLabelType = Literal["NEGATIVE", "MIXED", "NEUTRAL", "POSITIVE"]
ChannelType = Literal["AGENT", "CALLER"]
StatusType = Literal["STARTED", "TRANSCRIBING", "ERRORED", "ENDED"]
SentimentPeriodType = Literal["QUARTER"]


class SentimentEntry(TypedDict):
    """Sentiment Shape

    Held in a list per channel
    """

    Id: str
    BeginOffsetMillis: float
    EndOffsetMillis: float
    Sentiment: SentimentLabelType
    Score: float


class StatePerChannel(TypedDict, total=False):
    """StatePerChannel Shape

    Holds state per channel under StatePerCallId. Use to keep values needed
    for statistics and aggregations.
    """

    SentimentList: List[SentimentEntry]


class SentimentByPeriodEntry(TypedDict):
    """Sentiment By Period Shape"""

    BeginOffsetMillis: float
    EndOffsetMillis: float
    Score: float


class Sentiment(TypedDict, total=False):
    """Sentiment Shape"""

    OverallSentiment: Dict[ChannelType, float]
    SentimentByPeriod: Dict[SentimentPeriodType, Dict[ChannelType, List[SentimentByPeriodEntry]]]


class StatePerCallId(TypedDict, total=False):
    """StatePerCallId Shape

    Holds state per channel and general call status under the top level
    """

    StatePerChannel: Dict[ChannelType, StatePerChannel]
    Status: StatusType
    CreatedAt: str
    UpdatedAt: str

    TotalConversationDurationMillis: float
    Sentiment: Sentiment


class CallState(TypedDict):
    """CallState Shape

    Top level state holding state per call ID
    """

    StatePerCallId: Dict[str, StatePerCallId]
