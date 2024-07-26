/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { KinesisClient } = require('@aws-sdk/client-kinesis');

/* Transcribe and Streaming Libraries */
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  StartCallAnalyticsStreamTranscriptionCommand,
  ParticipantRole,
} = require('@aws-sdk/client-transcribe-streaming');
const transcribeStreamingPkg = require('@aws-sdk/client-transcribe-streaming/package.json');

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const BlockStream = require('block-stream2');
const fs = require('fs');
const stream = require('stream');
const { PassThrough } = require('stream');
const interleave = require('interleave-stream');

/* KVS Specific */
const { EbmlStreamDecoder, EbmlTagId, EbmlTagPosition } = require('ebml-stream');
const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoMedia } = require('@aws-sdk/client-kinesis-video-media');

/* Local libraries */
const { mergeFiles } = require('./mergeFiles');
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
// eslint-disable-next-line prettier/prettier
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const TRANSCRIBE_LANGUAGE_OPTIONS = process.env['TRANSCRIBE_LANGUAGE_OPTIONS'] || undefined;
const TRANSCRIBE_PREFERRED_LANGUAGE = process.env['TRANSCRIBE_PREFERRED_LANGUAGE'] || 'None';
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


const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const LAMBDA_INVOKE_TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;
const CHECK_CALL_STATUS_INTERVAL_MILLISECONDS = parseInt(process.env.CHECK_CALL_STATUS_INTERVAL_MILLISECONDS, 10) || 5000;

let s3Client;
let lambdaClient;
let dynamoClient;
// eslint-disable-next-line no-unused-vars
let kinesisClient;

let timeToStop = false;
let isCallEnded = false;
let isAgentPaused = false;
let isCallerPaused = false;
let stopTimer;
let keepAliveTimer;
let callStatusCheckTimer;
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

const writeToS3 = async function writeToS3(tempFileName) {
  const sourceFile = TEMP_FILE_PATH + tempFileName;
  console.log('Uploading audio to S3');
  let data;
  const fileStream = fs.createReadStream(sourceFile);
  const uploadParams = {
    Bucket: OUTPUT_BUCKET,
    Key: RAW_FILE_PREFIX + tempFileName,
    Body: fileStream,
  };
  try {
    data = await s3Client.send(new PutObjectCommand(uploadParams));
    console.log('Uploading to S3 complete: ', data);
  } catch (err) {
    console.error('S3 upload error: ', err);
  } finally {
    fileStream.destroy();
  }
  return data;
};

const deleteTempFile = async function deleteTempFile(sourceFile) {
  try {
    console.log('deleting tmp file');
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    console.error('error deleting: ', err);
  }
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
  console.log('GetItem params (getChannelStreamFromDynamo): ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let agentStreamArn;
  let loopCount = 0;

  // eslint-disable-next-line no-plusplus
  while (agentStreamArn === undefined && loopCount++ < retries) {
    const data = await dynamoClient.send(command);
    console.log('GetItem result (getChannelStreamFromDynamo): ', JSON.stringify(data));
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
    callStreamingStatus: 'STARTED',
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

const writeCallDataIdMappingToDdb = async function writeCallDataIdMappingToDdb(originalCallId, callId) {
  console.log(`Write callData mapping: ${originalCallId} => ${callId} to DDB`);
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `cm#${originalCallId}` },
      SK: { S: 'CALL_ID_MAPPING' },
      CallId: { S: callId },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error(`Error writing callData mapping: ${originalCallId} => ${callId} to DDB`, error);
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

const getCallDataWithOriginalCallIdFromDdb = async function getCallDataWithOriginalCallIdFromDdb(originalCallId) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `cm#${originalCallId}`,
      },
      SK: {
        S: 'CALL_ID_MAPPING',
      },
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log('GetItem CALL_ID_MAPPING params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let mappedCallId = undefined;
  try {
    const mappingData = await dynamoClient.send(command);
    console.log('GetItem CALL_ID_MAPPING result: ', JSON.stringify(mappingData));
    if (mappingData) {
      mappedCallId = mappingData?.Item?.CallId?.S;
    }
  } catch (error) {
    console.error('Error retrieving CALL_ID_MAPPING record (getCallDataWithOriginalCallIdFromDdb): ', error);
  }
  if (mappedCallId === undefined) {
    console.log(`No CALL_ID_MAPPING record found for originalCallId: ${originalCallId}`);
  }
  let callData = undefined;
  if (mappedCallId) {
    callData = await getCallDataFromDdb(mappedCallId);
  }
  // LCA stack may be updating while calls are in progress. Use originalCallId to retrieve the call data without the mapping
  if (callData === undefined) {
    console.log(`Try to find CallData using original callId ${originalCallId}`);
    callData = await getCallDataFromDdb(originalCallId);
  }
  return callData;
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
  console.log('GetItem params (getCallDataFromDdb): ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let callData;
  try {
    const data = await dynamoClient.send(command);
    console.log('GetItem result (getCallDataFromDdb): ', JSON.stringify(data));
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
    console.log(`ERROR: No callData stored for  CallId: ${callId} - exiting.`);
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

function timestampDeltaCheck(n) {
  // Log delta between producer and server timestamps for our two streams.
  const kvsProducerTimestampDelta = Math.abs(
    kvsProducerTimestamp.Caller - kvsProducerTimestamp.Agent,
  );
  const kvsServerTimestampDelta = Math.abs(kvsServerTimestamp.Caller - kvsServerTimestamp.Agent);
  if (kvsProducerTimestampDelta > n) {
    console.log(`WARNING: Producer timestamp delta of received audio is over ${n} seconds.`);
  }
  console.log(
    `Producer timestamps delta: ${kvsProducerTimestampDelta}, Caller: ${kvsProducerTimestamp.Caller}, Agent ${kvsProducerTimestamp.Agent}.`,
  );
  console.log(
    `Server timestamps delta: ${kvsServerTimestampDelta}, Caller: ${kvsServerTimestamp.Caller}, Agent ${kvsServerTimestamp.Agent}.`,
  );
}

const checkIfCallEnded = async (callId) => {
  console.log(`Checking if call has ended. (CallId: ${callId})`);
  const latestCallData = await getCallDataFromDdb(callId);
  if (latestCallData.callStreamingStatus === 'ENDED') {
    console.log(`CallData callStreamingStatus ENDED. Stop call processing for ${callId}`);
    isCallEnded = true;
    return true;
  }
  return false;
};

const getKVSstreamReader = async (streamArn, lastFragment) => {
  const kvClient = new KinesisVideoClient({ REGION });
  const getDataCmd = new GetDataEndpointCommand({ APIName: 'GET_MEDIA', StreamARN: streamArn });
  const response = await kvClient.send(getDataCmd);
  const mediaClient = new KinesisVideoMedia({ REGION, endpoint: response.DataEndpoint });
  let fragmentSelector = { StreamARN: streamArn, StartSelector: { StartSelectorType: 'NOW' } };
  if (lastFragment && lastFragment.length > 0) {
    fragmentSelector = {
      StreamARN: streamArn,
      StartSelector: {
        StartSelectorType: 'FRAGMENT_NUMBER',
        AfterFragmentNumber: lastFragment,
      },
    };
  }
  const result = await mediaClient.getMedia(fragmentSelector);
  const streamReader = result.Payload;
  return streamReader;
};

const readKVS = async (streamName, streamArn, lastFragment, streamPipe, callData) => {
  let firstDecodeEbml = true;
  let totalSize = 0;
  let lastMessageTime;

  console.log(`inside readKVS worker`, REGION, streamName, streamArn, ` (CallId: ${callData.callId})`);
  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.SimpleTag, EbmlTagId.SimpleBlock],
  });
  decoder.on('error', (error) => {
    console.log(`Decoder Error:`, JSON.stringify(error), ` (CallId: ${callData.callId})`);
  });
  decoder.on('data', (chunk) => {
    lastMessageTime = Date().now;
    if (chunk.id === EbmlTagId.Segment && chunk.position === EbmlTagPosition.End) {
      // this is the end of a segment. Lets forcefully stop if needed.
      if (timeToStop) {
        console.log(`Detected lambda timeout, stopping KVS read from ${streamName}. (CallId: ${callData.callId})`);
      }
      if (isCallEnded) {
        console.log(`Detected call end, stopping KVS read from ${streamName}. (CallId: ${callData.callId})`);
      }
    }
    if (!timeToStop) {
      if (chunk.id === EbmlTagId.SimpleTag) {
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_FRAGMENT_NUMBER') {
          lastFragment = chunk.Children[1].data;
        }
        // capture latest audio timestamps for stream in global variable
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_SERVER_TIMESTAMP') {
          kvsServerTimestamp[streamName] = chunk.Children[1].data;
        }
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_PRODUCER_TIMESTAMP') {
          kvsProducerTimestamp[streamName] = chunk.Children[1].data;
        }
        if (chunk.Children[0].data === 'CallId') {
          let fragmentCallId = chunk.Children[1].data;

          if (callData.originalCallId !== fragmentCallId) {
            console.log(`Error: ${streamName}'s MKV data has a Chime CallId of ${fragmentCallId}, expecting ${callData.originalCallId}. (CallId: ${callData.callId})`);

            (async () => {
              // write is call ended. Since these are async, calling them from within an anonymous promise
              console.log(`Mismatched CallId indicates that KVS stream has been recycled. We must end this call. (CallId: ${callData.callId})`);
              console.log(`Update callData record in DDB to set callStreamingStatus to ENDED. (CallId: ${callData.callId})`);
              isCallEnded = true;
              callData.callStreamingStatus = 'ENDED';
              callData.callStreamingEndTime = new Date().toISOString();
              await writeCallDataToDdb(callData);
            })();
          }
        }
      }
      if (chunk.id === EbmlTagId.SimpleBlock) {
        if (firstDecodeEbml) {
          firstDecodeEbml = false;
          console.log(`decoded ebml, simpleblock size:${chunk.size} stream: ${streamName}. (CallId: ${callData.callId})`);
          console.log(
            `${streamName} stream - producer timestamp: ${kvsProducerTimestamp[streamName]}, server timestamp: ${kvsServerTimestamp[streamName]}. (CallId: ${callData.callId})`,
          );
          timestampDeltaCheck(1);
        }
        try {
          if (!isAgentPaused && !isCallerPaused) {
            // this will only write audio to the interleaver if both KVS streams are running.
            streamPipe.write(chunk.payload);
          }
          // alternate solution here is to write blank audio to the second stream in the same chunk size as this chunk.
        } catch (error) {
          console.error(`Error posting payload chunk`, error, ` (CallId: ${callData.callId})`);
        }
      }
    }
  }); // use this to find last fragment tag we received
  decoder.on('end', () => {
    // close stdio
    console.log(`${streamName} Finished. (CallId: ${callData.callId})`);
    console.log(`Last fragment for ${streamName} ${lastFragment} total size: ${totalSize}. (CallId: ${callData.callId})`);
  });
  console.log(`Starting stream ${streamName}. (CallId: ${callData.callId})`);

  let streamReader = await getKVSstreamReader(streamArn, lastFragment);

  const timeout = setTimeout(() => {
    // Check every 10 seconds if 5 minutes have passed
    if (Date.now() - lastMessageTime > 1000 * 60 * 5) {
      clearInterval(timeout);
      streamReader.destroy();
    }
    // if (isCallEnded) {
    //   console.log(`Call has ended but ${streamName} is still reading from KVS, destroying reader.`);
    //   streamReader.destroy();
    // }
  }, 10000);

  let firstKvsChunk = true;
  try {
    while (true) {
      for await (const chunk of streamReader) {
        if (streamName === 'Agent' && isAgentPaused === true) {
          console.log(`Successfully restarted Agent stream. (CallId: ${callData.callId})`);
          isAgentPaused = false;
        }
        if (streamName === 'Caller' && isCallerPaused === true) {
          console.log(`Successfully restarted Caller stream. (CallId: ${callData.callId})`);
          isCallerPaused = false;
        }
        if (firstKvsChunk) {
          firstKvsChunk = false;
          console.log(`${streamName} received chunk size: ${chunk.length}. (CallId: ${callData.callId})`);
        }
        totalSize += chunk.length;
        decoder.write(chunk);
        if (isCallEnded || timeToStop) {
          break;
        }
      }
      if (streamName === 'Agent') isAgentPaused = true;
      if (streamName === 'Caller') isCallerPaused = true;

      if (!isCallEnded && !timeToStop) {
        lastFragment = '';
        console.log(`Reading KVS from ${streamName} ended, attempting to restart. (CallId: ${callData.callId})`);
        await sleep(1000);
        streamReader = await getKVSstreamReader(streamArn, lastFragment);
      } else {
        if (isCallEnded) {
          console.log(`${streamName} detected call ended, exiting KVS stream reading. (CallId: ${callData.callId})`);
        }
        if (timeToStop) {
          console.log(`${streamName} detected time to invoke new lambda, exiting KVS stream reading. (CallId: ${callData.callId})`);
        }
        break;
      }
    }
  } catch (error) {
    console.error(`error writing to decoder`, error, ` (CallId: ${callData.callId})`);
  } finally {
    console.log(`Closing buffers ${streamName}. (CallId: ${callData.callId})`);
    decoder.end();
  }

  return lastFragment;
};

const readTranscripts = async function readTranscripts(tsStream, callId, sessionId) {
  try {
    for await (const event of tsStream) {
      if (event.UtteranceEvent) {
        writeAddTranscriptSegmentEventToKds(kinesisClient, event.UtteranceEvent, undefined, callId);
      }
      if (event.CategoryEvent) {
        writeCategoryEventToKds(kinesisClient, event.CategoryEvent, callId);
      }
      if (event.TranscriptEvent) {
        writeTranscriptionSegmentToKds(kinesisClient, event.TranscriptEvent, callId);
      }
    }
  } catch (error) {
    console.error(`Error processing transcribe stream. SessionId: `, sessionId, error, ` (CallId: ${callId})`);
  } finally {
    console.log(`Transcribe stream has finished. (CallId: ${callId})`);
  }
};

const go = async function go(callData) {
  const {
    callId,
    fromNumber,
    agentId,
    callStreamingStartTime,
    agentStreamArn,
    callerStreamArn,
    lastAgentFragment,
    lastCallerFragment,
    tcaOutputLocation,
    lambdaCount,
    originalCallId
  } = callData;
  let sessionId = callData.sessionId;
  let firstChunkToTranscribe = true;
  const passthroughStream = new stream.PassThrough({ highWaterMark: BUFFER_SIZE });
  const audioStream = async function* audioStream() {
    try {
      if (isTCAEnabled) {
        const channel0 = { ChannelId: 0, ParticipantRole: ParticipantRole.CUSTOMER };
        const channel1 = { ChannelId: 1, ParticipantRole: ParticipantRole.AGENT };
        const channelDefinitions = [];
        channelDefinitions.push(channel0);
        channelDefinitions.push(channel1);
        let configurationEvent = {
          ChannelDefinitions: channelDefinitions,
        };
        if (IS_TCA_POST_CALL_ANALYTICS_ENABLED) {
          configurationEvent.PostCallAnalyticsSettings = {
            OutputLocation: tcaOutputLocation,
            DataAccessRoleArn: TCA_DATA_ACCESS_ROLE_ARN
          };
          if (IS_CONTENT_REDACTION_ENABLED) {
            configurationEvent.PostCallAnalyticsSettings.ContentRedactionOutput = POST_CALL_CONTENT_REDACTION_OUTPUT;
          }
        }
        console.log(`Sending TCA configuration event. (CallId: ${callId})`);
        console.log(JSON.stringify(configurationEvent));
        yield { ConfigurationEvent: configurationEvent };
      }
      for await (const payloadChunk of passthroughStream) {
        if (firstChunkToTranscribe) {
          firstChunkToTranscribe = false;
          console.log(`Sending first chunk to transcribe: `, payloadChunk.length, ` (CallId: ${callId})`);
        }
        yield { AudioEvent: { AudioChunk: payloadChunk } };
      }
    } catch (error) {
      console.log(`Error reading passthrough stream or yielding audio chunk. SessionId: `, sessionId, error, ` (CallId: ${callId})`);
    }
  };

  const tempRecordingFilename = `${callId}-${lambdaCount}.raw`;
  const writeRecordingStream = fs.createWriteStream(TEMP_FILE_PATH + tempRecordingFilename);

  let tsClientArgs = { region: REGION };
  if (TRANSCRIBE_ENDPOINT) {
    console.log(`Using custom Transcribe endpoint:`, TRANSCRIBE_ENDPOINT, ` (CallId: ${callId})`);
    tsClientArgs.endpoint = TRANSCRIBE_ENDPOINT;
  }
  console.log(`Transcribe client args:`, tsClientArgs, ` (CallId: ${callId})`);
  console.log('AWS SDK - @aws-sdk/client-transcribe-streaming version:', transcribeStreamingPkg.version);

  const tsClient = new TranscribeStreamingClient(tsClientArgs);
  let tsStream;
  const tsParams = {
    MediaSampleRateHertz: 8000,
    MediaEncoding: 'pcm',
    AudioStream: audioStream(),
  };

  /* configure stream transcription parameters */
  if (!isTCAEnabled) {
    tsParams.NumberOfChannels = 2;
    tsParams.EnableChannelIdentification = true;
  }

  if (TRANSCRIBE_LANGUAGE_CODE === 'identify-language') {
    tsParams.IdentifyLanguage = true;
    if (TRANSCRIBE_LANGUAGE_OPTIONS) {
      tsParams.LanguageOptions = TRANSCRIBE_LANGUAGE_OPTIONS.replace(/\s/g, '');
      if (TRANSCRIBE_PREFERRED_LANGUAGE !== 'None') {
        tsParams.PreferredLanguage = TRANSCRIBE_PREFERRED_LANGUAGE;
      }
    }
  } else if (TRANSCRIBE_LANGUAGE_CODE === 'identify-multiple-languages') {
    tsParams.IdentifyMultipleLanguages = true;
    if (TRANSCRIBE_LANGUAGE_OPTIONS) {
      tsParams.LanguageOptions = TRANSCRIBE_LANGUAGE_OPTIONS.replace(/\s/g, '');
      if (TRANSCRIBE_PREFERRED_LANGUAGE !== 'None') {
        tsParams.PreferredLanguage = TRANSCRIBE_PREFERRED_LANGUAGE;
      }
    }
  } else {
    tsParams.LanguageCode = TRANSCRIBE_LANGUAGE_CODE;
  }

  if (sessionId !== undefined) {
    tsParams.SessionId = sessionId;
  }

  if (IS_CONTENT_REDACTION_ENABLED && (
    TRANSCRIBE_LANGUAGE_CODE === 'en-US' ||
    TRANSCRIBE_LANGUAGE_CODE === 'en-AU' ||
    TRANSCRIBE_LANGUAGE_CODE === 'en-GB' ||
    TRANSCRIBE_LANGUAGE_CODE === 'es-US')) {
    tsParams.ContentRedactionType = CONTENT_REDACTION_TYPE;
    if (PII_ENTITY_TYPES) tsParams.PiiEntityTypes = PII_ENTITY_TYPES;
  }
  if (CUSTOM_VOCABULARY_NAME) {
    tsParams.VocabularyName = CUSTOM_VOCABULARY_NAME;
  }
  if (CUSTOM_LANGUAGE_MODEL_NAME) {
    tsParams.LanguageModelName = CUSTOM_LANGUAGE_MODEL_NAME;
  }

  /* start the stream - retry on exceptions */
  let tsResponse;
  let retryCount = 1;
  while (true) {
    try {
      if (isTCAEnabled) {
        console.log(`Transcribe StartCallAnalyticsStreamTranscriptionCommand args: ${JSON.stringify(tsParams)}, (CallId: ${callId})`);
        tsResponse = await tsClient.send(new StartCallAnalyticsStreamTranscriptionCommand(tsParams));
        tsStream = stream.Readable.from(tsResponse.CallAnalyticsTranscriptResultStream);
      } else {
        console.log(`Transcribe StartStreamTranscriptionCommand args: ${JSON.stringify(tsParams)}, (CallId: ${callId})`);
        tsResponse = await tsClient.send(new StartStreamTranscriptionCommand(tsParams));
        tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);
      }
      break;
    } catch (e) {
      console.log(`StartStream threw exception on attempt ${retryCount} of ${START_STREAM_MAX_RETRIES}: `, e, ` (CallId: ${callId})`);
      if (++retryCount > START_STREAM_MAX_RETRIES) throw e;
      sleep(START_STREAM_RETRY_WAIT_MS);
    }
  }

  sessionId = tsResponse.SessionId;
  console.log(`Transcribe SessionId: `, sessionId, ` (CallId: ${callId})`);

  /* cache session data in DDB - use to process post call output if/when needed */
  if (lambdaCount == 0) {
    const sessionData = {
      sessionId: sessionId,
      callId: callId,
      fromNumber: fromNumber,
      agentId: agentId,
      callStreamingStartTime: callStreamingStartTime,
      tcaOutputLocation: tcaOutputLocation,
      tsParams: tsParams,
    };
    await writeSessionDataToDdb(sessionData);
  }

  console.log(`creating readable from transcript stream. (CallId: ${callId})`);
  console.log(`creating interleave streams. (CallId: ${callId})`);
  const agentBlock = new BlockStream(2);
  const callerBlock = new BlockStream(2);
  const combinedStream = new PassThrough();
  const combinedStreamBlock = new BlockStream(4);
  combinedStream.pipe(combinedStreamBlock);
  combinedStreamBlock.on('data', (chunk) => {
    passthroughStream.write(chunk);
    writeRecordingStream.write(chunk);
  });
  interleave([agentBlock, callerBlock]).pipe(combinedStream);
  console.log(`starting workers. (CallId: ${callId})`);
  const callerWorker = readKVS('Caller', callerStreamArn, lastCallerFragment, callerBlock, callData);
  const agentWorker = readKVS('Agent', agentStreamArn, lastAgentFragment, agentBlock, callData);
  console.log(`done starting workers. (CallId: ${callId})`);

  console.log(`setting timer for LAMBDA_INVOKE_TIMEOUT to ${LAMBDA_INVOKE_TIMEOUT} msec. (CallId: ${callId})`);
  timeToStop = false;
  stopTimer = setTimeout(() => {
    console.log(`LAMBDA_INVOKE_TIMEOUT occurred. Time to stop = true (CallId: ${callId})`);
    timeToStop = true;
    clearTimeout(stopTimer);
    stopTimer = undefined;
  }, LAMBDA_INVOKE_TIMEOUT);

  console.log(`setting interval for KEEP_ALIVE to ${KEEP_ALIVE} msec. (CallId: ${callId})`);
  keepAliveTimer = setInterval(() => {
    if (timeToStop === true || isCallEnded) {
      console.log(`clearing KEEP_ALIVE interval from within interval. (CallId: ${callId})`);
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    } else {
      agentBlock.write(keepAliveChunk);
      callerBlock.write(keepAliveChunk);
    }
  }, KEEP_ALIVE);

  isCallEnded = false;
  console.log(`setting interval for CHECK_CALL_STATUS to ${CHECK_CALL_STATUS_INTERVAL_MILLISECONDS} msec. (CallId: ${callId})`);
  callStatusCheckTimer = setInterval(async () => {
    const callEnded = await checkIfCallEnded(callId);
    if (callEnded) {
      console.log(`clearing CHECK_CALL_STATUS interval. (CallId: ${callId})`);
      clearInterval(callStatusCheckTimer);
      callStatusCheckTimer = undefined;
    }
  }, CHECK_CALL_STATUS_INTERVAL_MILLISECONDS);

  const transcribePromise = readTranscripts(tsStream, callId, sessionId);

  const returnVals = await Promise.all([callerWorker, agentWorker]);

  // we are done with transcribe.
  passthroughStream.end();

  await transcribePromise;

  console.log(`Done with all 3 streams. (CallId: ${callId})`);
  console.log(`Last Caller Fragment: `, returnVals[0], ` (CallId: ${callId})`);
  console.log(`Last Agent Fragment: `, returnVals[1], ` (CallId: ${callId})`);

  // stop the timer so when we finish and upload to s3 this doesnt kick in
  if (stopTimer) {
    console.log(`clearing LAMBDA_INVOKE_TIMEOUT interval. (CallId: ${callId})`);
    clearTimeout(stopTimer);
    stopTimer = undefined;
  }

  // ensure call status timer is cleared since we're ending this processing loop.
  if (callStatusCheckTimer) {
    console.log(`clearing CHECK_CALL_STATUS interval. (CallId: ${callId})`);
    clearInterval(callStatusCheckTimer); // Stop the previous interval
    callStatusCheckTimer = undefined;
  }

  if (keepAliveTimer) {
    console.log(`clearing KEEP_ALIVE_TIMER interval. (CallId: ${callId})`);
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }

  writeRecordingStream.end();

  return {
    agentStreamArn,
    callerStreamArn,
    lastCallerFragment: returnVals[0],
    lastAgentFragment: returnVals[1],
    sessionId,
    tempFileName: tempRecordingFilename,
  };
};


// MAIN LAMBDA HANDLER - FUNCTION ENTRY POINT
const handler = async function handler(event, context) {
  console.log('Event: ', JSON.stringify(event));

  // Initialize clients (globals) each invocation to avoid possibility of ECONNRESET
  // in subsequent invocations.
  s3Client = new S3Client({ region: REGION });
  lambdaClient = new LambdaClient({ region: REGION });
  dynamoClient = new DynamoDBClient({ region: REGION });
  kinesisClient = new KinesisClient({ region: REGION });

  // make sure we've not inherited a running callStatusCheckTimer from a previously aborted lambda invocation
  if (callStatusCheckTimer) {
    console.log('Clearing previous callStatusCheckTimer');
    clearInterval(callStatusCheckTimer);
    callStatusCheckTimer = undefined;
  }

  // make sure we've not inherited a running keepAliveTimer from a previously aborted lambda invocation
  if (keepAliveTimer) {
    console.log('Clearing previous keepAliveTimer');
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }

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

  if (event.action === 'LAMBDA_CONTINUE') {
    callData = event.callData;
    console.log(
      '--- CONTINUING FROM PREVIOUS LAMBDA. LAMBDA SEQUENCE COUNT: ',
      callData.lambdaCount,
      '---',
      ` (CallId: ${callData.callId}) `,
    );
    if (callData.lambdaCount > 30) {
      console.log('Stopping due to runaway recursive Lambda.');
      return;
    }
  } else if (event.source === 'lca-solution' && event['detail-type'] === 'START_CALL_PROCESSING') {
    console.log('START_CALL_PROCESSING event received, Retrieving previously stored callData.');
    callData = await getCallDataForStartCallEvent(event.detail);
    if (!callData) {
      console.log('Nothing to do - exiting.');
      return;
    }
    await writeCallDataToDdb(callData);
    console.log(`Ready to start processing call. (CallId: ${callData.callId})`);
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

      console.log(`Saving callData to DynamoDB. (CallId: ${callData.callId})`);
      await writeCallDataToDdb(callData);
      await writeCallDataIdMappingToDdb(callData.originalCallId, callData.callId);

      if (callData.shouldProcessCall === false) {
        console.log(`CallData shouldProcessCall is false, exiting. (CallId: ${callData.callId})`);
        return;
      }
      console.log(`Ready to start processing call. (CallId: ${callData.callId})`);
      await writeCallStartEventToKds(kinesisClient, callData);
    } else if (event.detail.streamingStatus === 'ENDED') {
      console.log('AWS Chime stream ENDED event received. Update CallData status in DDB - this will terminate lambda processing for this call');
      // VC streaming ENDED uses the original callId. Use originalCallId to get the callData.
      const callDataFromDdb = await getCallDataWithOriginalCallIdFromDdb(event.detail.callId);
      if (callDataFromDdb) {
        callDataFromDdb.callStreamingStatus = 'ENDED';
        callDataFromDdb.callStreamingEndTime = new Date().toISOString();
        await writeCallDataToDdb(callDataFromDdb);
      } else {
        console.error('Error: We received a call ENDED event from Chime for a callId that is unknown to us!');
      }
      return;
    } else {
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

  console.log(`CallData: `, JSON.stringify(callData));
  let result;
  try {
    result = await go(callData);
  } catch (error) {
    console.log(`An unhandled exception occurred inside of the go(). Ending the call. (CallId: ${callData.callId})`, error);
    // Call has ended
    await writeCallEndEventToKds(kinesisClient, callData.callId);
    callData.callStreamingStatus = 'ENDED';
    callData.callStreamingEndTime = new Date().toISOString();
    await writeCallDataToDdb(callData);
  }
  if (result) {
    if (timeToStop) {
      console.log(
        `Lambda approaching max execution time. Starting a new Lambda to continue processing the call. (CallId: ${callData.callId})`,
      );
      const newEvent = {};
      newEvent.action = 'LAMBDA_CONTINUE';
      newEvent.callData = callData;
      newEvent.callData.lastAgentFragment = result.lastAgentFragment;
      newEvent.callData.lastCallerFragment = result.lastCallerFragment;
      newEvent.callData.sessionId = result.sessionId;
      newEvent.callData.lambdaCount = callData.lambdaCount + 1;
      console.log(`Launching new Lambda with event: `, JSON.stringify(newEvent), ` (CallId: ${callData.callId})`);
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(newEvent),
      });
      const res = await lambdaClient.send(invokeCmd);
      const newLambdaRequestId = res['$metadata'].requestId;
      console.log(`Launched new Lambda with RequestId: ${newLambdaRequestId}. (CallId: ${callData.callId})`);
    } else {
      // Call has ended
      await writeCallEndEventToKds(kinesisClient, callData.callId);
      callData.callStreamingStatus = 'ENDED';
      callData.callStreamingEndTime = new Date().toISOString();
      await writeCallDataToDdb(callData);
    }

    if (callData.shouldRecordCall) {
      // Write audio to s3 before completely exiting
      await writeToS3(result.tempFileName);
      await deleteTempFile(TEMP_FILE_PATH + result.tempFileName);
      if (!timeToStop) {
        try {
          await mergeFiles({
            bucketName: OUTPUT_BUCKET,
            recordingPrefix: RECORDING_FILE_PREFIX,
            rawPrefix: RAW_FILE_PREFIX,
            callId: callData.callId,
            lambdaCount: callData.lambdaCount,
          });
        } catch (error) {
          console.log(`Error merging S3 recording files:`, error, `( (CallId: ${callData.callId}))`);
        }
        await writeS3UrlToKds(kinesisClient, callData.callId);
      }
    }
  }
};

exports.handler = handler;
