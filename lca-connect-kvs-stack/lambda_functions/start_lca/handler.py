import boto3
from os import getenv
import json

def lambda_handler(event, context):
  connect_kvs_consumer_arn = getenv('CONNECT_KVS_CONSUMER_ARN','')
  connect_instance_arn = getenv('CONNECT_INSTANCE_ARN', '')

  if(connect_instance_arn != event['Details']['ContactData']['InstanceARN']):
     return {
        'statusCode':500,
        'body': json.dumps(f"Invalid Amazon Connect instance.")
     }
                                
  lambda_client = boto3.client('lambda')

  try:
      response = lambda_client.invoke(
         FunctionName=connect_kvs_consumer_arn,
         InvocationType='Event',
         Payload=json.dumps(event)
      )
  except Exception as e:
     return {
        'statusCode':500,
        'body': json.dumps(f"Error invoking Connect KVS Consumer Lambda: {e}")
     }
  return {
     'statusCode': 200,
     'body': json.dumps('Successfully invoked Connect KVS Consumer')
  }