import os
import boto3
from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError
import json
import logging
import openai
import pandas as pd

logger = logging.getLogger(__name__)

LCA_CALL_EVENTS_TABLE = os.environ['LCA_CALL_EVENTS_TABLE']

# TODO: Replace API KEY environment variable with "Secrets Manager"
OPENAI_API_KEY = os.environ['OPENAI_API_KEY'] 

ddb = boto3.resource('dynamodb')
lca_call_events = ddb.Table(LCA_CALL_EVENTS_TABLE)

openai.api_key = os.getenv("OPENAI_API_KEY")

def get_transcripts(callid):
    
    pk = 'trs#'+callid
    print(pk)
    
    try:
        response = lca_call_events.query(KeyConditionExpression=Key('PK').eq(pk), FilterExpression=(Attr('Channel').eq('AGENT') | Attr('Channel').eq('CALLER')) & Attr('IsPartial').eq(False))
        # response = lca_call_events.query(KeyConditionExpression=Key('PK').eq(pk)) 
    except ClientError as err:
        logger.error("Error getting transcripts from LCA Call Events table %s: %s", 
                err.response['Error']['Code'], err.response['Error']['Message'])
        raise 
    else:
        # print(response['Items'])
        return response['Items']

def preprocess_transcripts(transcripts):
    data = []

    df_transcripts = pd.DataFrame.from_dict(transcripts)
    # df_transcripts = df_transcripts.T
    df_transcripts.sort_values(by='StartTime', ascending=True, ignore_index=True, inplace=True)
    for index, row in df_transcripts.iterrows():
        transcript = row['Channel'] +" : " + row['Transcript']
        data.append(transcript)
    return data
    
            
def lambda_handler(event, context):

    # Setup model input data using text (utterances) received from LCA
    data = json.loads(json.dumps(event))
    callid = data['CallId']
    print(callid)
    print("\n")
    
    transcripts = get_transcripts(callid)
    transcripts = preprocess_transcripts(transcripts)
    prompt = '\n'.join(transcripts)
    prompt = "\n This is a conversation between a customer and an agent \n" + prompt + "\n Summarize the call \n"
    print(prompt)
    print("\n")

    response = openai.Completion.create(
        model="text-davinci-003",
        prompt=prompt,
        temperature=0.7,
        max_tokens=256,
        top_p=1,
        frequency_penalty=0,
        presence_penalty=0
    )

    summary = response.choices[0].text.split(".")
    summary = "\n".join(summary)
    print("CALL SUMMARY ==> ")
    print(summary)
    # print("\nCALL SUMMMARY : ",response.choices[0].text)
    print("\n")
    return response.choices[0].text