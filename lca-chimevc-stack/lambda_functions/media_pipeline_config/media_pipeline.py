import boto3
import json
import cfnresponse
import uuid
import traceback

responseData = {}

voiceClient = boto3.client('chime-sdk-voice')
mediaPipelineClient = boto3.client('chime-sdk-media-pipelines')
cloudformation = boto3.resource("cloudformation")

def is_valid_uuid(value):
  try:
    uuid.UUID(str(value))

    return True
  except ValueError:
    return False

def delete_pipeline_config(event):
  id = event.get('PhysicalResourceId','')
  pipelineConfigName = event['ResourceProperties'].get('StackName', '') + '-' + id
  id = mediaPipelineClient.delete_media_insights_pipeline_configuration(Identifier=pipelineConfigName)
  return {'PhysicalResourceId': id}

def find_media_pipeline_config(event):
  print('finding media pipeline')
  try:
    id = event.get('PhysicalResourceId','')
    pipelineConfigName = event['ResourceProperties'].get('StackName', '') + '-' + id
    response = mediaPipelineClient.get_media_insights_pipeline_configuration(Identifier=pipelineConfigName)
    return {
      'ConfigArn': response['MediaInsightsPipelineConfiguration']['MediaInsightsPipelineConfigurationArn'],
      'PhysicalResourceId': id
    }
  except Exception as e:
    error = f'Exception thrown: {e}.'
    print(error)
    return None

def generate_config(event, pipelineConfigName, resourceAccessRoleArn ):
  elements = []

  # configure kds
  kdsArn = event['ResourceProperties'].get('KinesisStreamArn', '')
  kds = {
      "Type": "KinesisDataStreamSink",
      "KinesisDataStreamSinkConfiguration": {
          "InsightsTarget": kdsArn
      }
  }
  elements.append(kds)
  
  # configure transcribe
  transcribeApiMode = event['ResourceProperties'].get('TranscribeApiMode', '')
  transcribeLanguageCode = event['ResourceProperties'].get('TranscribeLanguageCode', '')
  callAnalyticsFilePrefix = event['ResourceProperties'].get('CallAnalyticsFilePrefix', '')
  contentRedactionType = event['ResourceProperties'].get('ContentRedactionType', '')
  customLanguageModelName = event['ResourceProperties'].get('CustomLanguageModelName', '')
  customVocabularyName = event['ResourceProperties'].get('CustomVocabularyName', '')
  isContentRedactionEnabled = event['ResourceProperties'].get('IsContentRedactionEnabled', '')
  outputBucket = event['ResourceProperties'].get('OutputBucket', '')
  piiEntityTypes = event['ResourceProperties'].get('PiiEntityTypes', '')
  postCallContentRedactionOutput = event['ResourceProperties'].get('PostCallContentRedactionOutput', '')
  rawFilePrefix = event['ResourceProperties'].get('RawFilePrefix', '')
  recordingFilePrefix = event['ResourceProperties'].get('RecordingFilePrefix', '')
  tcaDataAccessRoleArn = event['ResourceProperties'].get('TcaDataAccessRoleArn', '')
  outputLocation = "s3://%s/%s"%(outputBucket,callAnalyticsFilePrefix)
  
  if transcribeApiMode == 'analytics':
    transcribeConfig = "AmazonTranscribeCallAnalyticsProcessorConfiguration"
    transcribe = {
      "Type":"AmazonTranscribeCallAnalyticsProcessor",
      "AmazonTranscribeCallAnalyticsProcessorConfiguration": { 
        "LanguageCode": transcribeLanguageCode,
        "PostCallAnalyticsSettings": { 
          "DataAccessRoleArn": tcaDataAccessRoleArn,
          "OutputLocation": outputLocation
        }
      }
    }
    if postCallContentRedactionOutput and isContentRedactionEnabled == 'true':
      transcribe[transcribeConfig]["PostCallAnalyticsSettings"]["ContentRedactionOutput"] = postCallContentRedactionOutput
  else:
    transcribeConfig = "AmazonTranscribeProcessorConfiguration"
    transcribe = {
      "Type":"AmazonTranscribeProcessor",
      "AmazonTranscribeProcessorConfiguration": {
        "LanguageCode": transcribeLanguageCode,
      }
    }
  if isContentRedactionEnabled == 'true':
    transcribe[transcribeConfig]["ContentRedactionType"] = contentRedactionType
    transcribe[transcribeConfig]["PiiEntityTypes"] = piiEntityTypes
  if customLanguageModelName:
    transcribe[transcribeConfig]["LanguageModelName"] = customLanguageModelName
  if customVocabularyName:
    transcribe[transcribeConfig]["VocabularyName"] = customVocabularyName
  elements.append(transcribe)
      
  # configure lambda sink
  lambdaSinkArn = event['ResourceProperties'].get('LambdaSinkArn', '')
  lambdaSink = {
    "Type": "LambdaFunctionSink",
    "LambdaFunctionSinkConfiguration": {
      "InsightsTarget": lambdaSinkArn
    }
  }
  elements.append(lambdaSink)
  
  # configure voice analytics
  enableVoiceToneAnalysis = event['ResourceProperties'].get('EnableVoiceToneAnalysis', '')
  enableSpeakerSearch = event['ResourceProperties'].get('EnableSpeakerSearch', '')
  voiceAnalytics =  {
    "Type": "VoiceAnalyticsProcessor",
    "VoiceAnalyticsProcessorConfiguration": {
      "VoiceToneAnalysisStatus": 'Enabled' if enableVoiceToneAnalysis == 'true' else 'Disabled',
      "SpeakerSearchStatus": 'Enabled' if enableSpeakerSearch == 'true' else 'Disabled'
    }
  }
  elements.append(voiceAnalytics)
  print(json.dumps(elements))
  return elements

def update_media_pipeline_config(event):
  id = event.get('PhysicalResourceId')
  pipelineConfigName = event['ResourceProperties'].get('StackName', '') + '-' + id
  print("Updating media pipeline config: ", pipelineConfigName)
  resourceAccessRoleArn = event['ResourceProperties'].get('ResourceAccessRoleArn', '')
  elements = generate_config(event, pipelineConfigName, resourceAccessRoleArn)
  response = mediaPipelineClient.update_media_insights_pipeline_configuration(
    Identifier=pipelineConfigName,
    ResourceAccessRoleArn=resourceAccessRoleArn,
    RealTimeAlertConfiguration={
      'Disabled': True
    },
    Elements=elements
  )
  return {
    'ConfigArn': response['MediaInsightsPipelineConfiguration']['MediaInsightsPipelineConfigurationArn'], 
    'PhysicalResourceId': id
  }

def create_media_pipeline_config(event, pipelineConfigName):
  print('creating media pipeline configuration')
  id = str(uuid.uuid4())
  pipelineConfigName = event['ResourceProperties'].get('StackName', '') + '-' + id 
  resourceAccessRoleArn = event['ResourceProperties'].get('ResourceAccessRoleArn', '')

  elements = generate_config(event, pipelineConfigName, resourceAccessRoleArn)
  
  response = mediaPipelineClient.create_media_insights_pipeline_configuration(
    MediaInsightsPipelineConfigurationName=pipelineConfigName,
    ResourceAccessRoleArn=resourceAccessRoleArn,
    RealTimeAlertConfiguration={
      'Disabled': True
    },
    Elements=elements
  )
  
  return {
    'ConfigArn': response['MediaInsightsPipelineConfiguration']['MediaInsightsPipelineConfigurationArn'],
    'PhysicalResourceId': id
  }
  

def get_vc_configuration(event):
  voiceConnectorId = event['ResourceProperties']['VoiceConnectorId'] 
  print(f"Getting existing configuration... {voiceConnectorId}")
  
  try:
    response = voiceClient.get_voice_connector_streaming_configuration(VoiceConnectorId=voiceConnectorId)
    streamingConfiguration = response["StreamingConfiguration"]
    print(json.dumps(streamingConfiguration))
    return streamingConfiguration
  except Exception as e:
    error = f'Error getting voice connector streaming config: {e}.'
    print(error)
  return None
      
def update_vc_configuration(event, config_arn, delete=False):
  print("Updating VC configuration")
  voiceConnectorId = event['ResourceProperties']['VoiceConnectorId'] 
  streamingConfiguration = get_vc_configuration(event)
  
  if streamingConfiguration is None:
    # nothing to do?
    return None
  
  if event['ResourceProperties']['EnableVoiceToneAnalysis'] == 'true' and delete == False:
    print("Enabling Voice Tone Analysis...")
    streamingConfiguration['MediaInsightsConfiguration'] = {
      "ConfigurationArn": config_arn
    }
  else:
    print("Disabling Voice Tone Analysis...")
    if 'MediaInsightsConfiguration' in streamingConfiguration:
      del streamingConfiguration['MediaInsightsConfiguration']
  print(json.dumps(streamingConfiguration))
  print("Saving configuration...")
  response = voiceClient.put_voice_connector_streaming_configuration(
    VoiceConnectorId=voiceConnectorId,
    StreamingConfiguration=streamingConfiguration
    )
  print(response)
  return response

def delete_vc_configuration(event):
  voiceConnectorId = event['ResourceProperties']['VoiceConnectorId'] 
  response = voiceClient.delete_voice_connector_streaming_configuration(
    VoiceConnectorId=voiceConnectorId
  )
  print(response)
  return response

def handler(event, context):
  print(event)
  responseData = {
    "success": True
  }
  try:
    if event['RequestType'] == "Create":
      responseData = create_media_pipeline_config(event)
      update_vc_configuration(event, responseData['ConfigArn'])
      cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
    elif event['RequestType'] == "Update":
      responseData = update_media_pipeline_config(event)
      update_vc_configuration(event, responseData['ConfigArn'])
      cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
    else:
      responseData = delete_pipeline_config(event)
      update_vc_configuration(event, None, True)
      cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
  except Exception as e:
    tb = traceback.format_exc()
    print(tb)
    error = f'Exception thrown: {e}. Please see https://github.com/aws-samples/amazon-transcribe-live-call-analytics/blob/main/TROUBLESHOOTING.md for more information.'
    print(error)
    cfnresponse.send(event, context, cfnresponse.FAILED, {}, reason=error )
