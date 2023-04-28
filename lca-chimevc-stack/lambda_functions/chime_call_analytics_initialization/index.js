/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { KinesisClient } = require('@aws-sdk/client-kinesis');

/* Transcribe and Streaming Libraries */
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const { ChimeSDKMediaPipelinesClient, CreateMediaInsightsPipelineCommand, GetMediaPipelineCommand } = require('@aws-sdk/client-chime-sdk-media-pipelines')


/* Local libraries */
const {
  formatPath,
  writeS3UrlToKds,
  writeAddTranscriptSegmentEventToKds,
  writeTranscriptionSegmentToKds,
  writeCallStartEventToKds,
  writeCallEndEventToKds,
  writeCategoryEventToKds,
} = require('./lca');

const REGION = process.env.REGION || 'us-east-1';
const { TRANSCRIBER_CALL_EVENT_TABLE_NAME } = process.env;
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = formatPath(process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/');
const CALL_ANALYTICS_FILE_PREFIX = formatPath(process.env.CALL_ANALYTICS_FILE_PREFIX || 'lca-call-analytics-json/');
const RAW_FILE_PREFIX = formatPath(process.env.RAW_FILE_PREFIX || 'lca-audio-raw/');
const TCA_DATA_ACCESS_ROLE_ARN = process.env.TCA_DATA_ACCESS_ROLE_ARN || '';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || '/tmp/';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128', 10);
// 
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';
const CUSTOM_LANGUAGE_MODEL_NAME = process.env.CUSTOM_LANGUAGE_MODEL_NAME || '';
const KEEP_ALIVE = process.env.KEEP_ALIVE || '10000';
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';
const TRANSCRIBE_API_MODE = process.env.TRANSCRIBE_API_MODE || 'standard';
const isTCAEnabled = TRANSCRIBE_API_MODE === 'analytics';

// optional - provide custom Transcribe endpoint via env var
const TRANSCRIBE_ENDPOINT = process.env.TRANSCRIBE_ENDPOINT || '';
// optional - disable post call analytics output
const IS_TCA_POST_CALL_ANALYTICS_ENABLED = (process.env.IS_TCA_POST_CALL_ANALYTICS_ENABLED || 'true') === 'true';
// optional - when redaction is enabled, choose 'redacted' only (dafault), or 'redacted_and_unredacted' for both
const POST_CALL_CONTENT_REDACTION_OUTPUT = process.env.POST_CALL_CONTENT_REDACTION_OUTPUT || 'redacted';
// optional - set retry count and delay if exceptions thrown by Start Stream api
const START_STREAM_MAX_RETRIES = parseInt(process.env.START_STREAM_RETRIES || '5', 10);
const START_STREAM_RETRY_WAIT_MS = parseInt(process.env.START_STREAM_RETRY_WAIT || '1000', 10);

const LCA_STACK_NAME = (process.env.LCA_STACK_NAME || '');

const CHIME_MEDIAPIPELINE_CONFIG_ARN = process.env.CHIME_MEDIAPIPELINE_CONFIG_ARN || '';

const ENABLE_VOICETONE = process.env.ENABLE_VOICETONE || 'false';


const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;

let lambdaClient;
let dynamoClient;
// eslint-disable-next-line no-unused-vars
let kinesisClient;
let chimeMediaPipelinesClient;

let timeToStop = false;
let stopTimer;
let keepAliveTimer;
const keepAliveChunk = Buffer.alloc(2, 0);
const kvsProducerTimestamp = {};
const kvsServerTimestamp = {};

const getExpiration = function getExpiration(numberOfDays) {
  return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const sleep = async function sleep(msec) {
  return new Promise((resolve) => {
    setTimeout(resolve, msec);
  });
};

// Retrieve Chime stream event for specified channel, waiting for up to 10s
const getChannelStreamFromDynamo = async function getChannelStreamFromDynamo(callId, channel, retries) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `ce#${callId}`,
      },
      SK: {
        S: `${channel}`,
      },
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log('GetItem params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let agentStreamArn;
  let loopCount = 0;

  // eslint-disable-next-line no-plusplus
  while (agentStreamArn === undefined && loopCount++ < retries) {
    const data = await dynamoClient.send(command);
    console.log('GetItem result: ', JSON.stringify(data));
    if (data.Item) {
      if (data.Item.StreamArn) agentStreamArn = data.Item.StreamArn.S;
    } else {
      console.log(`${channel} stream not yet available.`);
      if (loopCount < retries) {
        console.log(loopCount, `Sleeping 100ms.`);
        await sleep(100);
      }
    }
  }
  return agentStreamArn;
};

const getCallDataFromChimeEvents = async function getCallDataFromChimeEvents(callEvent) {
  const callerStreamArn = callEvent.detail.streamArn;
  const agentStreamArn = await getChannelStreamFromDynamo(callEvent.detail.callId, 'AGENT', 100);
  if (agentStreamArn === undefined) {
    console.log('Timed out waiting for AGENT stream event after 10s. Exiting.');
    return undefined;
  }

  const now = new Date().toISOString();
  const callData = {
    callId: callEvent.detail.callId,
    originalCallId: callEvent.detail.callId,
    callStreamingStartTime: now,
    callProcessingStartTime: now,
    callStreamingEndTime: '',
    shouldProcessCall: true,
    shouldRecordCall: true,
    fromNumber: callEvent.detail.fromNumber,
    toNumber: callEvent.detail.toNumber,
    agentId: callEvent.detail.agentId,
    metadatajson: undefined,
    callerStreamArn,
    agentStreamArn,
    lambdaCount: 0,
    sessionId: undefined,
    tcaOutputLocation: `s3://${OUTPUT_BUCKET}/${CALL_ANALYTICS_FILE_PREFIX}`,
  };

  // Call customer LambdaHook, if present
  if (LAMBDA_HOOK_FUNCTION_ARN) {
    // invoke lambda function
    // if it fails, just throw an exception and exit
    console.log(`Invoking LambdaHook: ${LAMBDA_HOOK_FUNCTION_ARN}`);
    const invokeCmd = new InvokeCommand({
      FunctionName: LAMBDA_HOOK_FUNCTION_ARN,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(callEvent),
    });
    const lambdaResponse = await lambdaClient.send(invokeCmd);
    const payload = JSON.parse(Buffer.from(lambdaResponse.Payload));
    console.log(`LambdaHook response: ${JSON.stringify(payload)}`);
    if (lambdaResponse.FunctionError) {
      console.log('Lambda failed to run, throwing an exception');
      throw new Error(payload);
    }
    /* Process the response. All fields optional:
        {
          // all fields optional
          originalCallId: <string>,
          shouldProcessCall: <boolean>,
          isCaller: <boolean>,
          callId: <string>,
          agentId: <string>,
          fromNumber: <string>,
          toNumber: <string>,
          shouldRecordCall: <boolean>,
          metadatajson: <string>
        }
    */

    // New CallId?
    if (payload.callId) {
      console.log(`Lambda hook returned new callId: "${payload.callId}"`);
      callData.callId = payload.callId;
    }

    // Swap caller and agent channels?
    if (payload.isCaller === false) {
      console.log('Lambda hook returned isCaller=false, swapping caller/agent streams');
      [callData.agentStreamArn, callData.callerStreamArn] = [
        callData.callerStreamArn,
        callData.agentStreamArn,
      ];
    }
    if (payload.isCaller === true) {
      console.log('Lambda hook returned isCaller=true, caller/agent streams not swapped');
    }

    // AgentId?
    if (payload.agentId) {
      console.log(`Lambda hook returned agentId: "${payload.agentId}"`);
      callData.agentId = payload.agentId;
    }

    // New 'to' or 'from' phone numbers?
    if (payload.fromNumber) {
      console.log(`Lambda hook returned fromNumber: "${payload.fromNumber}"`);
      callData.fromNumber = payload.fromNumber;
    }
    if (payload.toNumber) {
      console.log(`Lambda hook returned toNumber: "${payload.toNumber}"`);
      callData.toNumber = payload.toNumber;
    }

    // Metadata?
    if (payload.metadatajson) {
      console.log(`Lambda hook returned metadatajson: "${payload.metadatajson}"`);
      callData.metadatajson = payload.metadatajson;
    }

    // Should we process this call?
    if (payload.shouldProcessCall === false) {
      console.log('Lambda hook returned shouldProcessCall=false.');
      callData.shouldProcessCall = false;
      callData.callProcessingStartTime = '';
    }
    if (payload.shouldProcessCall === true) {
      console.log('Lambda hook returned shouldProcessCall=true.');
    }

    // Should we record this call?
    if (payload.shouldRecordCall === false) {
      console.log('Lambda hook returned shouldRecordCall=false.');
      callData.shouldRecordCall = false;
    }
    if (payload.shouldRecordCall === true) {
      console.log('Lambda hook returned shouldRecordCall=true.');
    }
  }
  return callData;
};

const writeChimeCallStartEventToDdb = async function writeChimeCallStartEventToDdb(callEvent) {
  const expiration = getExpiration(1);
  const eventType = EVENT_TYPE[callEvent.detail.streamingStatus];
  const channel = callEvent.detail.isCaller ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();

  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `ce#${callEvent.detail.callId}` },
      SK: { S: `${channel}` },
      CallId: { S: callEvent.detail.callId },
      ExpiresAfter: { N: expiration.toString() },
      CreatedAt: { S: now },
      CustomerPhoneNumber: { S: callEvent.detail.fromNumber },
      SystemPhoneNumber: { S: callEvent.detail.toNumber },
      Channel: { S: channel },
      EventType: { S: eventType },
      StreamArn: { S: callEvent.detail.streamArn },
    },
  };
  console.log('Writing Chime Call Start event to DynamoDB: ', JSON.stringify(putParams));
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Chime Call Start event', error);
  }
};

const writeCallDataToDdb = async function writeCallDataToDdb(callData) {
  console.log('Write callData to DDB');
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `cd#${callData.callId}` },
      SK: { S: 'BOTH' },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
      CallData: { S: JSON.stringify(callData) },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Call Data to Ddb', error);
  }
};

const writeSessionDataToDdb = async function writeSessionDataToDdb(sessionData) {
  console.log('Write sessionData to DDB');
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `sd#${sessionData.sessionId}` },
      SK: { S: 'TRANSCRIBE SESSION' },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
      SessionData: { S: JSON.stringify(sessionData) },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Session Data to Ddb', error);
  }
};


const getCallDataFromDdb = async function getCallDataFromDdb(callId) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `cd#${callId}`,
      },
      SK: {
        S: 'BOTH',
      },
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log('GetItem params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let callData;
  try {
    const data = await dynamoClient.send(command);
    console.log('GetItem result: ', JSON.stringify(data));
    callData = JSON.parse(data.Item.CallData.S);
  } catch (error) {
    console.log('Error retrieving callData - Possibly invalid callId?: ', error);
  }
  return callData;
};

const getCallDataForStartCallEvent = async function getCallDataForStartCallEvent(scpevent) {
  const { callId } = scpevent;
  const callData = await getCallDataFromDdb(callId);
  if (!callData) {
    console.log(`ERROR: No callData stored for callId: ${callId} - exiting.`);
    return undefined;
  }
  if (callData.callProcessingStartTime) {
    console.log(`ERROR: Call ${callId} is already processed/processing - exiting.`);
    return undefined;
  }
  // Add Start Call Event info to saved callData object and write back to DDB for tracing
  callData.startCallProcessingEvent = scpevent;
  callData.callProcessingStartTime = new Date().toISOString();
  /* Start Call Event can contain following optional fields, used to modify callData:
          agentId: <string>,
          fromNumber: <string>,
          toNumber: <string>
  */
  // AgentId?
  if (scpevent.agentId) {
    console.log(`START_CALL_PROCESSING event contains agentId: "${scpevent.agentId}"`);
    callData.agentId = scpevent.agentId;
  }
  // New 'to' or 'from' phone numbers?
  if (scpevent.fromNumber) {
    console.log(`START_CALL_PROCESSING event contains fromNumber: "${scpevent.fromNumber}"`);
    callData.fromNumber = scpevent.fromNumber;
  }
  if (scpevent.toNumber) {
    console.log(`START_CALL_PROCESSING event contains toNumber: "${scpevent.toNumber}"`);
    callData.toNumber = scpevent.toNumber;
  }
  return callData;
};

const startChimeCallAnalyticsMediaPipeline = async function startChimeCallAnalyticsMediaPipeline(mediaPipelineClient, callData) {

  try {
    console.log('Starting Media Pipeline...');
    let createMediaPipelineCommand = {
      'MediaInsightsPipelineConfigurationArn': CHIME_MEDIAPIPELINE_CONFIG_ARN,
      'MediaInsightsRuntimeMetadata':{
        'callId':callData.callId,
        'fromNumber':callData.fromNumber,
        'toNumber':callData.toNumber,
        'voiceConnectorId': callData.voiceConnectorId,
        'transactionId': callData.transactionId,
        'direction': callData.direction
      },
      'KinesisVideoStreamSourceRuntimeConfiguration': {
        'Streams': [
          {
            "StreamArn": callData.agentStreamArn,
            'StreamChannelDefinition': {
              'NumberOfChannels': 1,
              'ChannelDefinitions': [
                  {
                      'ChannelId': 0,
                      'ParticipantRole': 'CUSTOMER'
                  },
              ]
            }
          },{
            "StreamArn": callData.callerStreamArn,
            'StreamChannelDefinition': {
              'NumberOfChannels': 1,
              'ChannelDefinitions': [
                  {
                      'ChannelId': 1,
                      'ParticipantRole': 'AGENT'
                  },
              ]
            }
          },
        ],
        'MediaEncoding': 'pcm',
        'MediaSampleRate': 8000 // always for calls
      }
    };
    console.log("Media Pipeline Command:");
    console.log(JSON.stringify(createMediaPipelineCommand));
    let command = new CreateMediaInsightsPipelineCommand(createMediaPipelineCommand);
    let response = await mediaPipelineClient.send(command);
    console.log('Media Pipeline Started');
    console.log(JSON.stringify(response));
    let getPipelineInput = { // GetMediaPipelineRequest
      MediaPipelineId: response['MediaInsightsPipeline']['MediaPipelineId'], // required
    };

    /*for(let i = 0; i < 20; i++) {
      await sleep(1000);
      command = new GetMediaPipelineCommand(getPipelineInput);
      response = await mediaPipelineClient.send(command);
      console.log(JSON.stringify(response));
    }*/
  } catch (error) {
    console.error('Error writing Chime Call Start event', error);
  }
}


// MAIN LAMBDA HANDLER - FUNCTION ENTRY POINT
const handler = async function handler(event, context) {
  console.log('Event: ', JSON.stringify(event));

  // Initialize clients (globals) each invocation to avoid possibility of ECONNRESET
  // in subsequent invocations.
  lambdaClient = new LambdaClient({ region: REGION });
  dynamoClient = new DynamoDBClient({ region: REGION });
  kinesisClient = new KinesisClient({ region: REGION });
  chimeMediaPipelinesClient = new ChimeSDKMediaPipelinesClient({ region: REGION });

  /*
  Create a callData object for incoming event:
  A LAMBDA_CONTINUE event contains callData object ready to use
  A START_CALL_PROCESSING event contains callId which is used to look up a previously
  stored callData object
  Chime stream STARTED events for both AGENT and CALLER streams are combined to create
  a new callData object
    - the AGENT event is stored to DynamoDB and the function exits
    - the CALLER event is correlated with stored AGENT event to create callData object
    - an optional user defined Lambda hook may:
         - manipulate callData object fields
         - save callData object to DynamoDB and delay or disable call processing until/if
          a START_CALL_PROCESSING is received later
  */

  let callData;

  if (event.source === 'lca-solution' && event['detail-type'] === 'START_CALL_PROCESSING') {
    console.log('START_CALL_PROCESSING event received, Retrieving previously stored callData.');
    callData = await getCallDataForStartCallEvent(event.detail);
    if (!callData) {
      console.log('Nothing to do - exiting.');
      return;
    }
    await writeCallDataToDdb(callData);
    console.log('Ready to start processing call');
    await writeCallStartEventToKds(kinesisClient, callData);
  } else if (event.source === 'aws.chime') {
    if (event.detail.streamingStatus === 'STARTED') {
      if (event.detail.isCaller === undefined) {
        console.log('WARNING: Indeterminate channel (isCaller field is missing). If this is a production call, use RFC-1785 standard for SipRec Recording Metadata.');
        console.log('Assuming this is a test script call. Proceed with arbitrary channel assignment.');
        const interval = Math.floor(Math.random() * 10000);
        console.log(`Waiting random interval (${interval} msecs) to avoid race condition with matching event for other channel.`);
        await sleep(interval);
        console.log("Check if other stream channel event has already been stored as AGENT role");
        const otherStreamArn = await getChannelStreamFromDynamo(event.detail.callId, 'AGENT', 1);
        if (otherStreamArn === undefined) {
          console.log('This is the first event => Assigning AGENT channel role to this event');
          event.detail.isCaller = false;
        } else {
          console.log('This is the second event => Assigning CALLER channel role to this event');
          event.detail.isCaller = true;
        }
      }

      console.log('AWS Chime stream STARTED event received. Save event record to DynamoDB.');
      await writeChimeCallStartEventToDdb(event);

      if (event.detail.isCaller === false) {
        console.log(
          'This is the AGENT stream (isCaller is false). Exit and wait for CALLER stream event to arrive.',
        );
        return;
      }

      console.log(
        'This is the CALLER stream (isCaller is true). Collate with AGENT stream data from DynamoDB.',
      );
      callData = await getCallDataFromChimeEvents(event);

      console.log('Saving callData to DynamoDB');
      await writeCallDataToDdb(callData);

      if (callData.shouldProcessCall === false) {
        console.log('CallData shouldProcessCall is false, exiting.');
        return;
      }
      console.log('Ready to start processing call');
      await writeCallStartEventToKds(kinesisClient, callData);

      // it is now time to execute the mediapipeline
      if (ENABLE_VOICETONE === 'false') {
        await startChimeCallAnalyticsMediaPipeline(chimeMediaPipelinesClient, callData);
      } else {
        console.log("Voice tone is enabled, so we will not manually start the pipeline.")
      }

    } else if (event.detail.streamingStatus === 'ENDED') {
      callData = await getCallDataFromChimeEvents(event);
      await writeCallEndEventToKds(kinesisClient, callData.callId);
      callData.callStreamingEndTime = new Date().toISOString();
      await writeCallDataToDdb(callData);
    } 
    else {
      console.log(
        `AWS Chime stream status ${event.detail.streamingStatus}: Nothing to do - exiting`,
      );
      return;
    }
  }

  if (!callData) {
    console.log('Nothing to do - exiting');
    return;
  }

  console.log('CallData: ', JSON.stringify(callData));
};

exports.handler = handler;
