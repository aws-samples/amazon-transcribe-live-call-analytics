/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

// TODO: Add Metrics & Logger from Lambda Powertools
// TODO: Retries and resiliency
// TODO: Debug why sometimes it is now working twice

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} = require('@aws-sdk/client-transcribe-streaming');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const BlockStream = require('block-stream2');
const fs = require('fs');
const stream = require('stream');
const { PassThrough } = require('stream');
const interleave = require('interleave-stream');

const { EbmlStreamDecoder, EbmlTagId, EbmlTagPosition } = require('ebml-stream');
const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoMedia } = require('@aws-sdk/client-kinesis-video-media');

const mergeFiles = require('./mergeFiles');
const { KinesisClient, PutRecordCommand } = require('@aws-sdk/client-kinesis');

const REGION = process.env.REGION || 'us-east-1';
const { TRANSCRIBER_CALL_EVENT_TABLE_NAME } = process.env;
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/';
const RAW_FILE_PREFIX = process.env.RAW_FILE_PREFIX || 'lca-audio-raw/';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || '/tmp/';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128', 10);
const SAVE_PARTIAL_TRANSCRIPTS = (process.env.SAVE_PARTIAL_TRANSCRIPTS || 'true') === 'true';
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';
const KEEP_ALIVE = process.env.KEEP_ALIVE || '10000';
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME || '';
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;

var s3Client;
var lambdaClient;
var dynamoClient;
var kinesisClient;

let timeToStop = false;
let stopTimer;
let keepAliveTimer;
let keepAliveChunk = Buffer.alloc(2, 0);
let kvsProducerTimestamp = {};
let kvsServerTimestamp = {};

const getExpiration = function (numberOfDays) {
  return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const sleep = async function (msec) {
  return new Promise((resolve) => setTimeout(resolve, msec));
}

const writeS3UrlToKds = async function (callId) {
  console.log('Writing S3 URL To Dynamo');
  const now = new Date().toISOString();
  const eventType = 'ADD_S3_RECORDING_URL';
  const recordingUrl = `https://${OUTPUT_BUCKET}.s3.${REGION}.amazonaws.com/${RECORDING_FILE_PREFIX}${callId}.wav`;
  const putObj = {
    CallId: callId,
    RecordingUrl: recordingUrl,
    EventType: eventType.toString(),
    CreatedAt: now,
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  console.log("Sending ADD_S3_RECORDING_URL event on KDS: ", JSON.stringify(putObj));
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing ADD_S3_RECORDING_URL event', error);
  }
};

const writeToS3 = async function (tempFileName) {
  let sourceFile = TEMP_FILE_PATH + tempFileName;
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
    console.error('S3 upload error: ', JSON.stringify(err));
  } finally {
    fileStream.destroy();
  }
  return data;
};

const deleteTempFile = async function (sourceFile) {
  try {
    console.log('deleting tmp file');
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    console.error('error deleting: ', err);
  }
};

const writeTranscriptionSegmentToKds = async function (
  transcriptionEvent,
  callId,
  streamArn,
  transactionId,
) {
  // only write if there is more than 0
  const result = transcriptionEvent.TranscriptEvent.Transcript.Results[0];
  if (!result) return;
  if (result.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS) {
    return;
  }
  const transcript = result.Alternatives[0];
  if (!transcript.Transcript) return;

  console.log("Sending ADD_TRANSCRIPT_SEGMENT event on KDS");
  // log if stream timestamps are more than 1 sec apart.
  timestampDeltaCheck(1);

  const channel = result.ChannelId === 'ch_0' ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();
  const eventType = 'ADD_TRANSCRIPT_SEGMENT';

  const putObj = {
    Channel: channel,
    TransactionId: transactionId,
    CallId: callId,
    SegmentId: result.ResultId,
    StartTime: result.StartTime.toString(),
    EndTime: result.EndTime.toString(),
    Transcript: result.Alternatives[0].Transcript,
    IsPartial: result.IsPartial,
    EventType: eventType.toString(),
    CreatedAt: now,
    StreamArn: '<DEPRECATED>',
  };

  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing ADD_TRANSCRIPT_SEGMENT event', error);
  }
};

const writeCallStartEventToKds = async function (callData) {
  console.log("Write Call Start Event to KDS");
  const putObj = {
    CallId: callData.callId,
    CreatedAt: new Date().toISOString(),
    CustomerPhoneNumber: callData.fromNumber,
    SystemPhoneNumber: callData.toNumber,
    AgentId: callData.agentId,
    EventType: "START",
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callData.callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log("Sending Call START event on KDS: ", JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call START event', error);
  }
};

const writeCallEndEventToKds = async function (callId) {
  console.log("Write Call End Event to KDS");
  const putObj = {
    CallId: callId,
    EventType: "END_TRANSCRIPT",
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log("Sending Call END_TRANSCRIPT event on KDS: ", JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call END_TRANSCRIPT', error);
  }
};

const getCallDataFromChimeEvents = async function (callEvent) {
  let callerStreamArn = callEvent.detail.streamArn;
  let agentStreamArn = await getChannelStreamFromDynamo(
    callEvent.detail.callId,
    'AGENT',
  );
  if (agentStreamArn == undefined) {
    console.log(`Timed out waiting for AGENT stream event after 10s. Exiting.`);
    return;
  }

  let now = new Date().toISOString();
  let callData = {
    callId: callEvent.detail.callId,
    originalCallId: callEvent.detail.callId,
    callStreamingStartTime: now,
    callProcessingStartTime: now,
    callStreamingEndTime: "",
    shouldProcessCall: true,
    fromNumber: callEvent.detail.fromNumber,
    toNumber: callEvent.detail.toNumber,
    agentId: callEvent.detail.agentId,
    callerStreamArn: callerStreamArn,
    agentStreamArn: agentStreamArn,
    lambdaCount: 0,
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
          toNumber: <string>
        }
    */

    // New CallId?
    if (payload.callId) {
      console.log(`Lambda hook returned new callId: "${payload.callId}"`);
      callData.callId = payload.callId;
    }

    // Swap caller and agent channels?
    if (payload.isCaller === false) {
      console.log(`Lambda hook returned isCaller=false, swapping caller/agent streams`);
      [callData.agentStreamArn, callData.callerStreamArn] = [callData.callerStreamArn, callData.agentStreamArn];
    }
    if (payload.isCaller === true) {
      console.log(`Lambda hook returned isCaller=true, caller/agent streams not swapped`);
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

    // Should we process this call?
    if (payload.shouldProcessCall === false) {
      console.log('Lambda hook returned shouldProcessCall=false.');
      callData.shouldProcessCall = false;
      callData.callProcessingStartTime = "";
    }
    if (payload.shouldProcessCall === true) {
      console.log('Lambda hook returned shouldProcessCall=true.');
    }
  }
  return callData;
};

const writeChimeCallStartEventToDdb = async function (callEvent) {
    const startTime = new Date(callEvent.detail.startTime);
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
    console.log("Writing Chime Call Start event to DynamoDB: ", JSON.stringify(putParams));
    const putCmd = new PutItemCommand(putParams);
    try {
      await dynamoClient.send(putCmd);
    } catch (error) {
      console.error('Error writing Chime Call Start event', error);
    }
};

const writeCallDataToDdb = async function (callData) {
  console.log("Write callData to DDB");
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
    Item: {
      PK: { S: `cd#${callData.callId}` },
      SK: { S: `BOTH` },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
      CallData: { S: JSON.stringify(callData)},
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

const getCallDataForStartCallProcessingEvent = async function (scpevent) {
  const callId = scpevent.callId;
  let callData = await getCallDataFromDdb(callId);
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

const getCallDataFromDdb = async function (callId) {
  // Set the parameters
  const params = {
    Key: {
      "PK": {
        S: `cd#${callId}`
      },
      "SK": {
        S: `BOTH`
      }
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log("GetItem params: ", JSON.stringify(params));
  const command = new GetItemCommand(params);
  let callData;
  try {
    const data = await dynamoClient.send(command);
    console.log("GetItem result: ",JSON.stringify(data));
    callData = JSON.parse(data.Item.CallData.S);
  } catch (error) {
    console.log("Error retrieving callData - Possibly invalid callId?: ", error)
  }
  return callData;
};

// Retrieve Chime stream event for specified channel, waiting for up to 10s
const getChannelStreamFromDynamo = async function (callId, channel) {
  // Set the parameters
  const params = {
    Key: {
      "PK": {
        S: `ce#${callId}`
      },
      "SK": {
        S: `${channel}`
      }
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log("GetItem params: ", JSON.stringify(params));
  const command = new GetItemCommand(params);
  let agentStreamArn = undefined;
  let loopCount = 0;
  while (agentStreamArn === undefined && loopCount++ < 100) {
    const data = await dynamoClient.send(command);
    console.log("GetItem result: ",JSON.stringify(data));
    if (data.Item) {
      if (data.Item.StreamArn) agentStreamArn = data.Item.StreamArn.S;
    } else {
      console.log(loopCount, `${channel} stream not yet available. Sleeping 100ms.`);
      await sleep(100);
    }
  }
  return agentStreamArn;
};

function timestampDeltaCheck(n) {
  // Log delta between producer and server timestamps for our two streams.
  const kvsProducerTimestampDelta = Math.abs(kvsProducerTimestamp["Caller"] - kvsProducerTimestamp["Agent"]);
  const kvsServerTimestampDelta = Math.abs(kvsServerTimestamp["Caller"] - kvsServerTimestamp["Agent"]);
  if (kvsProducerTimestampDelta > n) {
    console.log(`WARNING: Producer timestamp delta of received audio is over ${n} seconds.`);
  }
  console.log(`Producer timestamps delta: ${kvsProducerTimestampDelta}, Caller: ${kvsProducerTimestamp["Caller"]}, Agent ${kvsProducerTimestamp["Agent"]}.`);
  console.log(`Server timestamps delta: ${kvsServerTimestampDelta}, Caller: ${kvsServerTimestamp["Caller"]}, Agent ${kvsServerTimestamp["Agent"]}.`);
}

const readKVS = async (streamName, streamArn, lastFragment, streamPipe) => {
  let actuallyStop = false;
  let firstDecodeEbml = true;
  let timestampDriftDetected = false;

  let lastMessageTime;

  console.log('inside readKVS worker', REGION, streamName, streamArn);
  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.SimpleTag, EbmlTagId.SimpleBlock],
  });
  decoder.on('error', (error) => {
    console.log('Decoder Error:', JSON.stringify(error));
  });
  decoder.on('data', (chunk) => {
    lastMessageTime = Date().now;
    if (chunk.id === EbmlTagId.Segment && chunk.position === EbmlTagPosition.End) {
      // this is the end of a segment. Lets forcefully stop if needed.
      if (timeToStop) actuallyStop = true;
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
      }
      if (chunk.id === EbmlTagId.SimpleBlock) {
        if (firstDecodeEbml) {
          firstDecodeEbml = false;
          console.log(`decoded ebml, simpleblock size:${chunk.size} stream: ${streamName}`);
          console.log(`${streamName} stream - producer timestamp: ${kvsProducerTimestamp[streamName]}, server timestamp: ${kvsServerTimestamp[streamName]}`);
          timestampDeltaCheck(1);
        }
        try {
          streamPipe.write(chunk.payload);
        } catch (error) {
          console.error('Error posting payload chunk', error);
        }
      }
    }
  }); // use this to find last fragment tag we received
  decoder.on('end', () => {
    // close stdio
    console.log(streamName, 'Finished');
    console.log(`Last fragment for ${streamName} ${lastFragment} total size: ${totalSize}`);
  });
  console.log(`Starting stream ${streamName}`);
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

  const timeout = setTimeout(() => {
    // Check every 10 seconds if 5 minutes have passed
    if (Date.now() - lastMessageTime > 1000 * 60 * 5) {
      clearInterval(timeout);
      streamReader.destroy();
    }
  }, 10000);

  let totalSize = 0;
  let firstKvsChunk = true;
  try {
    for await (const chunk of streamReader) {
      if (firstKvsChunk) {
        firstKvsChunk = false;
        console.log(`${streamName} received chunk size: ${chunk.length}`);
      }
      totalSize += chunk.length;
      decoder.write(chunk);
      if (actuallyStop) break;
    }
  } catch (error) {
    console.error('error writing to decoder', error);
  } finally {
    console.log(`Closing buffers ${streamName}`);
    decoder.end();
  }

  return lastFragment;
};


const readTranscripts = async function (tsStream, callId, callerStreamArn, sessionId) {
  try {
    for await (const chunk of tsStream) {
      writeTranscriptionSegmentToKds(chunk, callId, callerStreamArn, sessionId);
    }
  } catch (error) {
    console.error('error writing transcription segment', JSON.stringify(error));
  } finally {
  }
};

const go = async function (
  callId,
  lambdaCount,
  agentStreamArn,
  callerStreamArn,
  sessionId,
  lastAgentFragment,
  lastCallerFragment,
) {
  let firstChunkToTranscribe = true;
  const passthroughStream = new stream.PassThrough({ highWaterMark: BUFFER_SIZE });
  const audioStream = async function* () {
    try {
      for await (const payloadChunk of passthroughStream) {
        if (firstChunkToTranscribe) {
          firstChunkToTranscribe = false;
          console.log('Sending first chunk to transcribe: ', payloadChunk.length);
        }
        yield { AudioEvent: { AudioChunk: payloadChunk } };
      }
    } catch (error) {
      console.log('Error reading passthrough stream or yielding audio chunk.');
    }
  };

  const tempRecordingFilename = `${callId}-${lambdaCount}.raw`;
  const writeRecordingStream = fs.createWriteStream(TEMP_FILE_PATH + tempRecordingFilename);

  const tsClient = new TranscribeStreamingClient({ region: REGION });
  const tsParams = {
    LanguageCode: TRANSCRIBE_LANGUAGE_CODE,
    MediaEncoding: 'pcm',
    MediaSampleRateHertz: 8000,
    NumberOfChannels: 2,
    EnableChannelIdentification: true,
    AudioStream: audioStream(),
  };

  if (sessionId !== undefined) {
    tsParams.SessionId = sessionId;
  }

  if (IS_CONTENT_REDACTION_ENABLED && TRANSCRIBE_LANGUAGE_CODE === 'en-US') {
    tsParams.ContentRedactionType = CONTENT_REDACTION_TYPE;
    if (PII_ENTITY_TYPES) tsParams.PiiEntityTypes = PII_ENTITY_TYPES;
  }

  if (CUSTOM_VOCABULARY_NAME) {
    tsParams.VocabularyName = CUSTOM_VOCABULARY_NAME;
  }

  const tsCmd = new StartStreamTranscriptionCommand(tsParams);
  const tsResponse = await tsClient.send(tsCmd);
  // console.log(tsResponse);
  sessionId = tsResponse.SessionId;
  console.log('creating readable from transcript stream');
  const tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);

  console.log('creating interleave streams');
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
  console.log('starting workers');

  const callerWorker = readKVS('Caller', callerStreamArn, lastCallerFragment, callerBlock);
  const agentWorker = readKVS('Agent', agentStreamArn, lastAgentFragment, agentBlock);

  console.log('done starting workers');

  timeToStop = false;
  stopTimer = setTimeout(() => {
    timeToStop = true;
  }, TIMEOUT);

  keepAliveTimer = setInterval(() => {
    if (timeToStop === true) {
      clearInterval(keepAliveTimer);
    } else {
      agentBlock.write(keepAliveChunk);
      callerBlock.write(keepAliveChunk);
    }
  }, KEEP_ALIVE);

  const transcribePromise = readTranscripts(tsStream, callId, callerStreamArn, sessionId);

  const returnVals = await Promise.all([callerWorker, agentWorker]);

  // we are done with transcribe.
  passthroughStream.end();

  await transcribePromise;

  console.log('Done with all 3 streams');
  console.log('Last Caller Fragment: ', returnVals[0]);
  console.log('Last Agent Fragment: ', returnVals[1]);

  // stop the timer so when we finish and upload to s3 this doesnt kick in
  if (timeToStop === false) {
    clearTimeout(stopTimer);
    timeToStop = false;
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
const handler = async function (event, context) {

  console.log("Event: ", JSON.stringify(event));

  // initialise clients (globals) each invocation to avoid possibility of ECONNRESET in subsequent invocations.
  s3Client = new S3Client({ region: REGION });
  lambdaClient = new LambdaClient({ region: REGION });
  dynamoClient = new DynamoDBClient({ region: REGION });
  kinesisClient = new KinesisClient({ region: REGION });

  /*
  Create a callData object for incoming event:
  A LAMBDA_CONTINUE event contains callData object ready to use
  A START_CALL_PROCESSING event contains callId which is used to look up a previously stored callData object
  Chime stream STARTED events for both AGENT and CALLER streams are combined to create a new callData object
    - the AGENT event is stored to DynamoDB and the function exits
    - the CALLER event is correlated with stored AGENT event to create callData object
    - an optional user defined Lambda hook may:
         - manipulate callData object fields
         - save callData object to DynamoDB and delay or disable call processing until/if a START_CALL_PROCESSING is received later
  */

  let callData;

  if (event['action'] === 'LAMBDA_CONTINUE') {
    callData = event.callData;
    console.log('--- CONTINUING FROM PREVIOUS LAMBDA. LAMBDA SEQUENCE COUNT: ', callData.lambdaCount, '---');
    if (callData.lambdaCount > 30) {
      console.log('Stopping due to runaway recursive Lambda.');
      return;
    }
  }

  else if (event['source'] === 'lca-solution' && event['detail-type'] === 'START_CALL_PROCESSING') {
    console.log('START_CALL_PROCESSING event received, Retrieving previously stored callData.');
    callData = await getCallDataForStartCallProcessingEvent(event.detail);
    if (!callData) {
      console.log('Nothing to do - exiting.');
      return;
    }
    await writeCallDataToDdb(callData);
    console.log("Ready to start processing call")
    await writeCallStartEventToKds(callData);
  }

  else if (event['source'] === "aws.chime") {
    if (event.detail.streamingStatus === 'STARTED') {
      console.log("AWS Chime stream STARTED event received. Save event record to DynamoDB.");
      await writeChimeCallStartEventToDdb(event);

      if (event.detail.isCaller === false) {
        console.log("This is the AGENT stream (isCaller is false). Exit and wait for CALLER stream event to arrive.");
        return;
      }

      console.log("This is the CALLER stream (isCaller is true). Collate with AGENT stream data from DynamoDB.");
      callData = await getCallDataFromChimeEvents(event);

      console.log("Saving callData to DynamoDB");
      await writeCallDataToDdb(callData);

      if (callData.shouldProcessCall === false) {
        console.log('CallData shouldProcessCall is false, exiting.');
        return;
      }
      console.log("Ready to start processing call")
      await writeCallStartEventToKds(callData);
    }
    else {
      console.log(`AWS Chime stream status ${event.detail.streamingStatus}: Nothing to do - exiting`)
      return;
    }
  }

  if (!callData) {
    console.log("Nothing to do - exiting")
    return;
  }

  console.log("CallData: ", JSON.stringify(callData));
  let result = await go(
    callData.callId,
    callData.lambdaCount,
    callData.agentStreamArn,
    callData.callerStreamArn,
    callData.transcribeSessionId || undefined,
    callData.lastAgentFragment || undefined,
    callData.lastCallerFragment || undefined,
  );
  if (result) {
    if (timeToStop) {
      console.log('Lambda approaching max execution time. Starting a new Lambda to continue processing the call.');
      let newEvent = {};
      newEvent.action = 'LAMBDA_CONTINUE';
      newEvent.callData = callData;
      newEvent.callData.lastAgentFragment = result.lastAgentFragment;
      newEvent.callData.lastCallerFragment = result.lastCallerFragment;
      newEvent.callData.transcribeSessionId = result.sessionId;
      newEvent.callData.lambdaCount = callData.lambdaCount + 1;
      console.log("Launching new Lambda with event: ", JSON.stringify(newEvent))
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(newEvent),
      });
      await lambdaClient.send(invokeCmd);
    } else {
      // Call has ended
      await writeCallEndEventToKds(callData.callId);
      callData.callStreamingEndTime = new Date().toISOString();
      await writeCallDataToDdb(callData);
    }

    // Write audio to s3 before completely exiting
    await writeToS3(result.tempFileName);
    await deleteTempFile(TEMP_FILE_PATH + result.tempFileName);

    if (!timeToStop) {
      await mergeFiles.mergeFiles({
        bucketName: OUTPUT_BUCKET,
        recordingPrefix: RECORDING_FILE_PREFIX,
        rawPrefix: RAW_FILE_PREFIX,
        callId: callData.callId,
        lambdaCount: callData.lambdaCount,
      });
      await writeS3UrlToKds(callData.callId);
    }
  }
  return;
};

exports.handler = handler;
