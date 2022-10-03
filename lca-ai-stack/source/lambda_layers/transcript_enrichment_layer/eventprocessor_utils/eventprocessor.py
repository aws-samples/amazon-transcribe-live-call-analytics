from typing import TYPE_CHECKING, Any, Coroutine, Dict, List, Literal, Optional
from datetime import datetime, timedelta
from os import getenv
import uuid
import asyncio
from sentiment import ComprehendWeightedSentiment

if TYPE_CHECKING:
    from mypy_boto3_comprehend.type_defs import DetectSentimentResponseTypeDef
    from mypy_boto3_comprehend.client import ComprehendClient
else:
    ComprehendClient = object
    DetectSentimentResponseTypeDef = object

DYNAMODB_EXPIRATION_IN_DAYS = getenv("DYNAMODB_EXPIRATION_IN_DAYS", "90")
 
SENTIMENT_WEIGHT = dict(POSITIVE=5, NEGATIVE=-5, NEUTRAL=0, MIXED=0)

SENTIMENT_SCORE = dict(
    Positive=0,
    Negative=0,
    Neutral=0,
    Mixed=0,
)

# Get value for DynamboDB TTL field
def get_ttl():
    return int((datetime.utcnow() + timedelta(days=int(DYNAMODB_EXPIRATION_IN_DAYS))).timestamp())

# Transform Transcript segment fields
def normalize_transcript_segment(message: Dict) -> Dict[str, object]:
    """Transforms Kinesis Stream Transcript Payload to addTranscript API"""
    
    call_id: str = None
    channel: str = None
    segment_id: str = None
    start_time: float = None
    end_time: float = None
    transcript: str = None
    is_partial: bool = None
    sentiment: str = None
    issuesdetected = None
    status: str = "TRANSCRIBING"
    expires_afer = get_ttl()
    created_at = datetime.utcnow().astimezone().isoformat()


    call_id = message["CallId"]

    utteranceEvent = message.get("UtteranceEvent", None)
    transcriptEvent = message.get("TranscriptEvent", None)

    if (utteranceEvent): # TCA streaming event in KDS
        channel = utteranceEvent["ParticipantRole"]
        if channel == "CUSTOMER":
            channel = "CALLER"
        segment_id = utteranceEvent["UtteranceId"]
        start_time = utteranceEvent["BeginOffsetMillis"]/1000
        end_time = utteranceEvent["EndOffsetMillis"]/1000
        transcript = utteranceEvent["Transcript"]
        is_partial = utteranceEvent["IsPartial"]
        if not is_partial and utteranceEvent.get("Sentiment", None):
            sentiment: str = utteranceEvent.get("Sentiment", None)
        
        if not is_partial and utteranceEvent.get("IssuesDetected", []):
            issuesdetected = utteranceEvent.get("IssuesDetected")

    elif(transcriptEvent): # Standard Transcribe streaming event in KDS
        channel = transcriptEvent["Channel"]
        if channel == "CUSTOMER":
            channel = "CALLER"
        segment_id = transcriptEvent["ResultId"]
        start_time = transcriptEvent["StartTime"]
        end_time = transcriptEvent["EndTime"]
        transcript = transcriptEvent["Transcript"]
        is_partial = transcriptEvent["IsPartial"]
        sentiment = None
        issuesdetected = None
        
    else:    # custom event message in KDS    
        channel = "CALLER"
        if message.get("Channel", None):
            channel = message["Channel"]
        else:
            iscaller: bool = message.get("IsCaller", True)
            if iscaller:
                channel = "CALLER"
            else:
                channel = "AGENT"
        
        if message.get("SegmentId", None):
            segment_id = message["SegmentId"]
        else:
            segment_id = str(uuid.uuid4())
        
        if message.get("BeginOffsetMillis", None):
            start_time = message["BeginOffsetMillis"]
        if message.get("StartTime", None):
            start_time = message["StartTime"]
        
        if message.get("EndOffsetMillis", None):
            end_time = message["EndOffsetMillis"]
        if message.get("EndTime", None):
            end_time = message["EndTime"]
        
        transcript = message["Transcript"]
        is_partial = message["IsPartial"]
        
        if message.get("Sentiment", None):
            sentiment = message["Sentiment"]

    return dict(
        CallId=call_id,
        Channel=channel,
        SegmentId=segment_id,
        StartTime=start_time,
        EndTime=end_time,
        Transcript=transcript,
        IsPartial=is_partial,
        Sentiment=sentiment,
        IssuesDetected=issuesdetected,
        Status=status,
        ExpiresAfter=expires_afer,
        CreatedAt=created_at,
    )

async def detect_sentiment(text: str, COMPREHEND_CLIENT:ComprehendClient, COMPREHEND_LANGUAGE_CODE) -> DetectSentimentResponseTypeDef:
    loop = asyncio.get_running_loop()
    sentiment_future = loop.run_in_executor(
        None,
        lambda: COMPREHEND_CLIENT.detect_sentiment(
            Text=text,
            LanguageCode=COMPREHEND_LANGUAGE_CODE,
        ),
    )
    results = await asyncio.gather(sentiment_future)
    result = results[0]
    return result

async def transform_segment_to_add_sentiment(message: Dict, sentiment_analysis_args: Dict) -> Dict[str, object]:

    sentiment_label_in_message = message.get("Sentiment", None)

    sentiment = {}
    if (sentiment_label_in_message): # we received sentiment label in transcript, use it.
        sentimentlabel: str = ""
        if sentiment_label_in_message.strip()=="":
            sentimentlabel = "NEUTRAL"
        else:
            sentimentlabel= sentiment_label_in_message
        sentiment = dict(
            Sentiment=sentimentlabel,
            SentimentScore=SENTIMENT_SCORE,
            SentimentWeighted=None,
        )
        if sentimentlabel in ["POSITIVE", "NEGATIVE"]:
            sentiment["SentimentWeighted"] = SENTIMENT_WEIGHT.get(sentimentlabel, 0)
    else: # did not receive sentiment label, so call Comprehend to figure out sentiment

        text = message.get("Transcript", "")
        comprehend_client: ComprehendClient = sentiment_analysis_args.get("comprehend_client")
        comprehend_language_coe = message.get("comprehend_language_code", "en")

        sentiment_response:DetectSentimentResponseTypeDef = await detect_sentiment(text, comprehend_client, comprehend_language_coe)
        comprehend_weighted_sentiment = ComprehendWeightedSentiment()

        sentiment = {
            k: v for k, v in sentiment_response.items() if k in ["Sentiment", "SentimentScore"]
        }

        if sentiment:
            if sentiment.get("Sentiment") in ["POSITIVE", "NEGATIVE"]:
                sentiment["SentimentWeighted"] = comprehend_weighted_sentiment.get_weighted_sentiment_score(
                        sentiment_response=sentiment_response
                    )
    transcript_segment_with_sentiment = {
        **message,
        **sentiment
    }
    return transcript_segment_with_sentiment

def transform_segment_to_issues_agent_assist(
    message: Dict[str, Any],
    issue: Dict[str, Any],
) -> Dict[str, Any]:
    """Transforms Contact Lens Transcript Issues payload to Agent Assist"""
    # pylint: disable=too-many-locals


    begin_offset = issue["CharacterOffsets"]["Begin"]
    end_offset = issue["CharacterOffsets"]["End"]
    issue_transcript = message["Transcript"][begin_offset:end_offset]

    return dict(
        CallId=message["CallId"],
        Channel="AGENT_ASSISTANT",
        IsPartial=False,
        SegmentId=str(uuid.uuid4()),
        StartTime=message["StartTime"],
        EndTime=message["EndTime"] + 0.001,
        Status="TRANSCRIBING",
        Transcript=issue_transcript,
        CreatedAt=message["CreatedAt"],
        ExpiresAfter=get_ttl(),
    )