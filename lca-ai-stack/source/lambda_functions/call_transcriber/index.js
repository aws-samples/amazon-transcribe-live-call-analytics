/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

// TODO: Add Metrics & Logger from Lambda Powertools
// TODO: Retries and resiliency
// TODO: Debug why sometimes it is now working twice
// TODO: Decouple transcribe and lca


const { DynamoDBClient, QueryCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} = require('@aws-sdk/client-transcribe-streaming');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { Worker } = require('worker_threads');
const BlockStream = require('block-stream2');
const fs = require('fs');
const stream = require('stream');
const { PassThrough } = require('stream');
const interleave = require('interleave-stream');
const mergeFiles = require('./mergeFiles');

const REGION = process.env.REGION || 'us-east-1';
const { EVENT_SOURCING_TABLE_NAME } = process.env;
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/';
const RAW_FILE_PREFIX = process.env.RAW_FILE_PREFIX || 'lca-audio-raw/';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || '/tmp/';
const EXPIRATION_IN_DAYS = parseInt(process.env.EXPIRATION_IN_DAYS || '90');
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128');
const SAVE_PARTIAL_TRANSCRIPTS = (process.env.SAVE_PARTIAL_TRANSCRIPTS || 'true') === 'true';
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT) || 720000;

const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

let timeToStop = false;
let stopTimer;

const writeS3Url = async function (callId) {
  console.log('Writing S3 URL To Dynamo');

  const now = new Date().toISOString();
  const expiration = Math.round(Date.now() / 1000) + EXPIRATION_IN_DAYS * 24 * 3600;
  const eventType = 'ADD_S3_RECORDING_URL';
  const recordingUrl = `https://${OUTPUT_BUCKET}.s3.${REGION}.amazonaws.com/${RECORDING_FILE_PREFIX}${callId}.wav`;

  const putParams = {
    TableName: EVENT_SOURCING_TABLE_NAME,
    Item: {
      PK: { S: `ce#${callId}` },
      SK: { S: `ts#${now}#et#${eventType}` },
      CallId: { S: callId },
      RecordingUrl: { S: recordingUrl },
      EventType: { S: eventType.toString() },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
    },
  };
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing S3 url to Dynamo', error);
  }
};

const writeToS3 = async function (sourceFile, destBucket, destPrefix, destKey) {
  console.log('Uploading to S3');

  let data;
  const fileStream = fs.createReadStream(sourceFile);
  const uploadParams = {
    Bucket: OUTPUT_BUCKET,
    Key: destPrefix + destKey,
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

const writeTranscriptionSegment = async function (
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

  const channel = result.ChannelId === 'ch_0' ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();
  const expiration = Math.round(Date.now() / 1000) + EXPIRATION_IN_DAYS * 24 * 3600;
  const eventType = 'ADD_TRANSCRIPT_SEGMENT';

  const putParams = {
    TableName: EVENT_SOURCING_TABLE_NAME,
    Item: {
      PK: { S: `ce#${callId}` },
      SK: { S: `ts#${now}#et#${eventType}#c#${channel}` },
      Channel: { S: channel },
      StreamArn: { S: streamArn },
      TransactionId: { S: transactionId },
      CallId: { S: callId },
      SegmentId: { S: result.ResultId },
      StartTime: { N: result.StartTime.toString() },
      EndTime: { N: result.EndTime.toString() },
      Transcript: { S: result.Alternatives[0].Transcript },
      IsPartial: { BOOL: result.IsPartial },
      EventType: { S: eventType.toString() },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
    },
  };
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing transcription segment', error);
  }
};

const writeCallEventToDynamo = async function (callEvent) {
  const startTime = new Date(callEvent.detail.startTime);
  const expiration = Math.round(startTime.getTime() / 1000) + EXPIRATION_IN_DAYS * 24 * 3600;
  const eventType = EVENT_TYPE[callEvent.detail.streamingStatus];
  const channel = callEvent.detail.isCaller ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();

  const putParams = {
    TableName: EVENT_SOURCING_TABLE_NAME,
    Item: {
      PK: { S: `ce#${callEvent.detail.callId}` },
      SK: { S: `ts#${callEvent.detail.startTime}#et#${eventType}#c#${channel}` },
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
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing event', error);
  }
};

const writeStatusToDynamo = async function (channel, status, callId, streamArn, transactionId) {
  const now = new Date().toISOString();
  const expiration = Math.round(Date.now() / 1000) + EXPIRATION_IN_DAYS * 24 * 3600;
  const putParams = {
    TableName: EVENT_SOURCING_TABLE_NAME,
    Item: {
      PK: { S: `ce#${callId}` },
      SK: { S: `"ts#${now}#et${status}#c#${channel}` },
      CallId: { S: callId },
      Channel: { S: channel },
      StreamArn: { S: streamArn },
      TransactionId: { S: transactionId },
      EventType: { S: status },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing status', error);
  }
};

// Query KVS for START events for this callId
const getStreamsFromDynamo = async function (callId, agentArn, callerArn) {
  const resultArns = {
    agentStreamArn: agentArn, // 'agent-channel-stream';
    callerStreamArn: callerArn, // 'caller-channel-stream';
  };

  console.log('Retrieving KVS');
  // Set the parameters
  const dynamoParams = {
    KeyConditionExpression: 'PK = :ce',
    FilterExpression: '#event = :event',
    ExpressionAttributeNames: {
      '#event': 'EventType',
    },
    ExpressionAttributeValues: {
      ':ce': { S: `ce#${callId}` },
      ':event': { S: 'START' },
    },
    TableName: EVENT_SOURCING_TABLE_NAME,
  };

  console.log(JSON.stringify(dynamoParams));
  const command = new QueryCommand(dynamoParams);

  try {
    const data = await dynamoClient.send(command);
    data.Items.forEach((item) => {
      console.log(JSON.stringify(item));
      console.log(`Channel:${item.Channel.S}`);
      if (item.Channel.S === 'AGENT') {
        console.log('Found agent stream');
        resultArns.agentStreamArn = item.StreamArn.S;
      }
      if (item.Channel.S === 'CALLER') {
        console.log('Found caller stream');
        resultArns.callerStreamArn = item.StreamArn.S;
      }
    });
  } catch (error) {
    if (error === undefined) console.error('no error');
    else console.error('Error with connection to database: ', error);
  }
  return resultArns;
};

// returns a promise, so we can await it
const runKVSWorker = function (workerData, streamPipe) {
  let newWorker;

  const workerPromise = new Promise((resolve, reject) => {
    console.log('instantiating worker');
    newWorker = new Worker('./kvsWorker.js', { workerData });
    console.log('done instantiating worker');
    newWorker.on('message', (message) => {
      if (message.type === 'chunk') {
        // console.log('writing chunk to ffmpeg');
        try {
          streamPipe.write(message.chunk);
        } catch (error) {
          console.log('error writing to ffmpeg pipe', error);
        }
      }
      if (message.type === 'lastFragment') {
        console.log('last fragment:', message.streamName, message.lastFragment);
        resolve(message.lastFragment);
      }
    });
    newWorker.on('error', reject);
    newWorker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
  workerPromise.worker = newWorker;
  return workerPromise;
};

const readTranscripts = async function (tsStream, callId, callerStreamArn, sessionId) {
  try {
    for await (const chunk of tsStream) {
      writeTranscriptionSegment(chunk, callId, callerStreamArn, sessionId);
    }
  } catch (error) {
    console.error('error writing transcription segment', JSON.stringify(error));
    writeStatusToDynamo('STEREO', 'TRANSCRIPT_ERROR', callId, callerStreamArn, sessionId);
  } finally {
    // writeStatusToDynamo('STEREO', 'END_TRANSCRIPT', callId, callerStreamArn, sessionId);
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

  if(sessionId !== undefined) {
    tsParams.sessionId = sessionId;
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
  if (lastAgentFragment === undefined)
    writeStatusToDynamo('STEREO', 'START_TRANSCRIPT', callId, callerStreamArn, sessionId);
  else writeStatusToDynamo('STEREO', 'CONTINUE_TRANSCRIPT', callId, callerStreamArn, sessionId);
  console.log('creating readable from transcript stream');
  const tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);

  console.log('creating interleave streams');
  const agentBlock = new BlockStream(2);
  const callerBlock = new BlockStream(2);
  const combinedStream = new PassThrough();
  const combinedStreamBlock = new BlockStream(4); // TODO: Calculate this size based on 250ms 'chunks'
  combinedStream.pipe(combinedStreamBlock);
  combinedStreamBlock.on('data', (chunk) => {
    passthroughStream.write(chunk);
    writeRecordingStream.write(chunk);
  });

  interleave([agentBlock, callerBlock]).pipe(combinedStream);
  console.log('starting workers');
  const callerWorker = runKVSWorker(
    {
      region: REGION,
      streamName: 'Caller',
      streamArn: callerStreamArn,
      lastFragment: lastCallerFragment,
    },
    callerBlock,
  );

  const agentWorker = runKVSWorker(
    {
      region: REGION,
      streamName: 'Agent',
      streamArn: agentStreamArn,
      lastFragment: lastAgentFragment,
    },
    agentBlock,
  );

  console.log('done starting workers');

  timeToStop = false;
  stopTimer = setTimeout(() => {
    timeToStop = true;
    agentWorker.worker.postMessage('Agent, Time to stop!');
    callerWorker.worker.postMessage('Caller, Time to stop!');
  }, TIMEOUT);

  const transcribePromise = readTranscripts(tsStream, callId, callerStreamArn, sessionId);

  const returnVals = await Promise.all([callerWorker, agentWorker]);

  // we are done with transcribe.
  // passthroughStream.write(Buffer.alloc(0));
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

// async function handler (event) {
const handler = async function (event, context) {
  if (!event.detail.lambdaCount) event.detail.lambdaCount = 0;
  if (event.detail.lambdaCount > 30) {
    console.log('Stopping due to runaway recursive Lambda.');
  }

  console.log(JSON.stringify(event));
  await writeCallEventToDynamo(event);

  let result;

  if (event.detail.streamingStatus === 'CONTINUE') {
    console.log('---CONTINUING FROM PREVIOUS LAMBDA: ', event.detail.lambdaCount, '---');
    result = await go(
      event.detail.callId,
      event.detail.lambdaCount,
      event.detail.agentStreamArn,
      event.detail.callerStreamArn,
      event.detail.transcribeSessionId,
      event.detail.lastAgentFragment,
      event.detail.lastCallerFragment,
    );
  } else if (event.detail.streamingStatus === 'STARTED') {
    let agentStreamArn;
    let callerStreamArn;

    // save which stream we just received from event
    if (event.detail.isCaller === true) callerStreamArn = event.detail.streamArn;
    else agentStreamArn = event.detail.streamArn;

    const streamResults = await getStreamsFromDynamo(
      event.detail.callId,
      agentStreamArn,
      callerStreamArn,
    );
    console.log(`agent stream:${streamResults.agentStreamArn}`);
    console.log(`caller stream:${streamResults.callerStreamArn}`);

    if (streamResults.agentStreamArn === undefined || streamResults.callerStreamArn === undefined) {
      console.log('Agent or caller streams not yet available.');
      return 'not done yet'; // TODO: Figure out what to return from Lambda
    }
    result = await go(
      event.detail.callId,
      0,
      streamResults.agentStreamArn,
      streamResults.callerStreamArn,
      undefined,
      undefined,
      undefined,
    );
  }

  if (result) {
    if (timeToStop) {
      console.log('Starting new Lambad');
      event.detail.streamingStatus = 'CONTINUE';
      event.detail.agentStreamArn = result.agentStreamArn;
      event.detail.callerStreamArn = result.callerStreamArn;
      event.detail.lastAgentFragment = result.lastAgentFragment;
      event.detail.lastCallerFragment = result.lastCallerFragment;
      event.detail.transcribeSessionId = result.sessionId;
      if (!event.detail.lambdaCount) event.detail.lambdaCount = 1;
      else event.detail.lambdaCount = event.detail.lambdaCount + 1;

      // we need to launch a new one
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(event),
      });
      await lambdaClient.send(invokeCmd);
    } else {
      writeStatusToDynamo(
        'STEREO',
        'END_TRANSCRIPT',
        event.detail.callId,
        event.detail.streamArn,
        event.detail.transcribeSessionId ? event.detail.transcribeSessionId : '',
      );
    }

    // regardless, write to s3 before completely exiting
    await writeToS3(
      TEMP_FILE_PATH + result.tempFileName,
      OUTPUT_BUCKET,
      RAW_FILE_PREFIX,
      result.tempFileName,
    );
    await deleteTempFile(TEMP_FILE_PATH + result.tempFileName);

    if (!timeToStop) {
      await mergeFiles.mergeFiles({
        bucketName: OUTPUT_BUCKET,
        recordingPrefix: RECORDING_FILE_PREFIX,
        rawPrefix: RAW_FILE_PREFIX,
        callId: event.detail.callId,
        lambdaCount: event.detail.lambdaCount,
      });
      await writeS3Url(event.detail.callId);
    }
  }
  return 'not done yet';
};

exports.handler = handler;
