# Invokes Anthropic generate text API using requests module
# see https://console.anthropic.com/docs/api/reference for more details

import sys
import os
import json
import re
import boto3
import requests

# grab environment variables
ANTHROPIC_MODEL_IDENTIFIER = os.environ["ANTHROPIC_MODEL_IDENTIFIER"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
ENDPOINT_URL = os.environ["ENDPOINT_URL"]
FETCH_TRANSCRIPT_LAMBDA_ARN = os.environ['FETCH_TRANSCRIPT_LAMBDA_ARN']
PROCESS_TRANSCRIPT = (os.getenv('PROCESS_TRANSCRIPT', 'False') == 'True')
TOKEN_COUNT = int(os.getenv('TOKEN_COUNT', '0')) # default 0 - do not truncate.
SUMMARY_PROMPT_TEMPLATE = os.environ["SUMMARY_PROMPT_TEMPLATE"]

lambda_client = boto3.client('lambda')

def get_transcripts(callId):
    payload = {
        'CallId': callId, 
        'ProcessTranscript': PROCESS_TRANSCRIPT, 
        'TokenCount': TOKEN_COUNT 
    }
    print("Invoking lambda", payload)
    response = lambda_client.invoke(
        FunctionName=FETCH_TRANSCRIPT_LAMBDA_ARN,
        InvocationType='RequestResponse',
        Payload=json.dumps(payload)
    )
    print("Lambda response:", response)
    return response

def handler(event, context):
    print("Received event: ", json.dumps(event))
    callId = event['CallId']
    transcript_response = get_transcripts(callId)
    transcript_data = transcript_response['Payload'].read().decode()
    print("Transcript data:", transcript_data)
    transcript_json = json.loads(transcript_data)
    transcript = transcript_json['transcript']
    prompt = SUMMARY_PROMPT_TEMPLATE.replace("<br>", "\n").replace("{transcript}", transcript)
    print("Prompt: ",prompt)
    data = {
        "prompt": prompt,
        "model": ANTHROPIC_MODEL_IDENTIFIER,
        "max_tokens_to_sample": 512,
        "stop_sequences": ["Human:", "Assistant:"]
    }
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "content-type": "application/json"
    }
    response = requests.post(ENDPOINT_URL, headers=headers, data=json.dumps(data))
    print("API Response:", response)
    summaryText = json.loads(response.text)["completion"].strip()
    print("Summary: ", summaryText)
    return {"summary": summaryText}

    
# for testing on terminal
if __name__ == "__main__":
    event = {
        "CallId": "8cfc6ec4-0dbe-4959-b1f3-34f13359826b"
    }
    handler(event)
