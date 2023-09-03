# Invokes Anthropic generate text API using requests module
# see https://console.anthropic.com/docs/api/reference for more details

import sys
import os
import json
import re
import boto3
import requests

import logging
logger = logging.getLogger()
logger.setLevel(logging.ERROR)

# grab environment variables
BEDROCK_MODEL_ID = os.environ["BEDROCK_MODEL_ID"]
FETCH_TRANSCRIPT_LAMBDA_ARN = os.environ['FETCH_TRANSCRIPT_LAMBDA_ARN']
PROCESS_TRANSCRIPT = (os.getenv('PROCESS_TRANSCRIPT', 'False') == 'True')
TOKEN_COUNT = int(os.getenv('TOKEN_COUNT', '0')) # default 0 - do not truncate.
SUMMARY_PROMPT_TEMPLATE = os.environ["SUMMARY_PROMPT_TEMPLATE"]

# Optional environment variables allow region / endpoint override for bedrock Boto3
BEDROCK_REGION = os.environ["BEDROCK_REGION_OVERRIDE"] if "BEDROCK_REGION_OVERRIDE" in os.environ else os.environ["AWS_REGION"]
BEDROCK_ENDPOINT_URL = os.environ.get("BEDROCK_ENDPOINT_URL", f'https://bedrock.{BEDROCK_REGION}.amazonaws.com')

lambda_client = boto3.client('lambda')
bedrock = boto3.client(service_name='bedrock', region_name=BEDROCK_REGION, endpoint_url=ENDPOINT_URL) 

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

def get_summary(prompt_data):

    modelId = BEDROCK_MODEL_ID
    accept = 'application/json'
    contentType = 'application/json'

    summary_text = "Unsupported Bedrock model ID "+modelId+". Unable to generate call summary"
    provider = modelId.split(".")[0]

    if provider == "amazon":
        body = json.dumps({"inputText": prompt_data})        
        response = bedrock.invoke_model(body=body, modelId=modelId, accept=accept, contentType=contentType)
        response_body = json.loads(response.get('body').read())
        summary_text = response_body.get('results')[0].get('outputText')

    elif provider == "ai21":
        body = json.dumps({"prompt": prompt_data})
        response = bedrock.invoke_model(body=body, modelId=modelId, accept=accept, contentType=contentType)
        response_body = json.loads(response.get('body').read())
        summary_text = response_body.get('completions')[0].get('data').get('text')

    elif provider == "anthropic":
        body = json.dumps({"prompt": prompt_data, "max_tokens_to_sample": 512})
        response = bedrock.invoke_model(body=body, modelId=modelId, accept=accept, contentType=contentType)
        response_body = json.loads(response.get('body').read())
        summary_text = response_body.get('completion')

    return summary_text

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

    try:
        summaryText  = get_summary(prompt_data=prompt)

    except Exception as err:
        summaryText = "Error calling Bedrock API. Unable to get call summary. See logs for error details"
        logger.error(err)

    print("Summary: ", summaryText)
    return {"summary": summaryText}
    
# for testing on terminal
if __name__ == "__main__":
    event = {
        "CallId": "8cfc6ec4-0dbe-4959-b1f3-34f13359826b"
    }
    handler(event)
