import boto3
import botocore
import cfnresponse
import json

cf = boto3.client('cloudformation')
ssm = boto3.client('ssm')
def addBotToAistack(event):
  response = cf.describe_stacks(StackName=event["AISTACK"])
  orig_params = [
    p for p in response["Stacks"][0]["Parameters"] if p["ParameterKey"] not in ['LexAgentAssistBotId', 'LexAgentAssistBotAliasId'] 
  ]
  bot_params = [
        {
            'ParameterKey': 'LexAgentAssistBotId',
            'ParameterValue': event["LexAgentAssistBotId"]
        },
        {
            'ParameterKey': 'LexAgentAssistAliasId',
            'ParameterValue': event["LexAgentAssistAliasId"]
        }    
    ]
  try:
    response = cf.update_stack(
      StackName=event["AISTACK"],
      UsePreviousTemplate=True,
      Parameters=orig_params + bot_params,
      Capabilities=['CAPABILITY_NAMED_IAM','CAPABILITY_AUTO_EXPAND']
    )
    waiter = cf.get_waiter('stack_update_complete')
    print("...waiting for stack to be ready...")
    waiter.wait(StackName=event["AISTACK"])
    print("Stack updated")
  except botocore.exceptions.ClientError as ex:
      error_message = ex.response['Error']['Message']
      if error_message == 'No updates are to be performed.':
          print("No changes in stack changeset")
      else:
          raise

def configureQnabotSettings(event):
  response = cf.describe_stacks(StackName=event["QNABOTSTACK"])
  outputs = {}
  for output in response["Stacks"][0]["Outputs"]:
    outputs[output["OutputKey"]] = output["OutputValue"]
  ssmParamName = outputs["DefaultSettingsSSMParameterName"]
  value = ssm.get_parameter(Name=ssmParamName)
  settings = json.loads(value["Parameter"]["Value"])
  # modify settings
  settings["ALT_SEARCH_KENDRA_INDEXES"] = event["KendraIndexId"]
  settings["KENDRA_FAQ_INDEX"] = event["KendraIndexId"]
  settings["ALT_SEARCH_KENDRA_FALLBACK_CONFIDENCE_SCORE"] = "VERY HIGH"
  settings["KENDRA_FAQ_ES_FALLBACK"] = "false"
  settings["ALT_SEARCH_KENDRA_ANSWER_MESSAGE"] = "Amazon Kendra suggestions."
  # save back to SSM
  response = ssm.put_parameter(
    Name=ssmParamName,
    Value=json.dumps(settings),
    Type='String',
    Overwrite=True
  )
  print(f"Updated SSM parameter: {ssmParamName}")

def handler(event, context):
  print(event)
  status = cfnresponse.SUCCESS
  responseData = {}
  responseData['Data'] = "Success"
  if event['RequestType'] != 'Delete':
    try:
      addBotToAistack(event)
      if event["QNABOTSTACK"]:
        configureQnabotSettings(event)
    except Exception as e:
      print(e)
      responseData["Error"] = f"Exception thrown: {e}"
      status = cfnresponse.FAILED
  #cfnresponse.send(event, context, status, responseData)

event={
  "RequestType":"Create",
  "AISTACK":"arn:aws:cloudformation:us-east-1:912625584728:stack/LiveCallAnalytics-AA-6-AISTACK-YYRWL5S18L77/cdf4e6e0-e8d5-11ec-8b21-0aea1aa9c9bb",
  "QNABOTSTACK":"arn:aws:cloudformation:us-east-1:912625584728:stack/LiveCallAnalytics-AA-6-QNABOT-1KI7IWJT04TUL/cdca7b80-e8d5-11ec-81de-0ecc52db8987",
  "LexAgentAssistBotId":"IXRV37OYVJ",
  "LexAgentAssistAliasId":"TMFTOGFFMI",
  "KendraIndexId":"4778f75d-3445-44b0-a3f1-ef339a036651"
}
handler(event,{})
