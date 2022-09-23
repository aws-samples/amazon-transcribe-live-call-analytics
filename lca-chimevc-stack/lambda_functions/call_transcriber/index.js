/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { DynamoDBClient, QueryCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

/* Transcribe and Streaming Libraries */
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  StartCallAnalyticsStreamTranscriptionCommand,
  ParticipantRole,
} = require('@aws-sdk/client-transcribe-streaming');
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
  writeS3Url,
  writeTranscriptionSegment,
  writeUtteranceEvent,
  writeCategoryEvent,
  writeCallEventToKds,
  writeStatusToKds,
} = require('./lca');

const REGION = process.env.REGION || 'us-east-1';
const { EVENT_SOURCING_TABLE_NAME } = process.env;
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/';
const RAW_FILE_PREFIX = process.env.RAW_FILE_PREFIX || 'lca-audio-raw/';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || '/tmp/';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128', 10);
// eslint-disable-next-line prettier/prettier
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';
const KEEP_ALIVE = process.env.KEEP_ALIVE || '10000';
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';
const TRANSCRIBE_API_MODE = process.env.TRANSCRIBE_API_MODE || 'standard';
const isTCAEnabled = TRANSCRIBE_API_MODE === 'analytics';

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;

const s3Client = new S3Client({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });

let timeToStop = false;
let stopTimer;
let keepAliveTimer;
const keepAliveChunk = Buffer.alloc(2, 0);

const getExpiration = function getExpiration(numberOfDays) {
  return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const sleep = async function sleep(msec) {
  return new Promise((resolve) => {
    setTimeout(resolve, msec);
  });
};

const writeToS3 = async function writeToS3(sourceFile, destBucket, destPrefix, destKey) {
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

const deleteTempFile = async function deleteTempFile(sourceFile) {
  try {
    console.log('deleting tmp file');
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    console.error('error deleting: ', err);
  }
};

const writeCallEventToDynamo = async function writeCallEventToDynamo(callEvent) {
  const expiration = getExpiration(1);
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

// Query KVS for START events for this callId
const getStreamsFromDynamo = async function getStreamsFromDynamo(callId, agentArn, callerArn) {
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

const readKVS = async (streamName, streamArn, lastFragment, streamPipe) => {
  let actuallyStop = false;
  let firstDecodeEbml = true;
  let totalSize = 0;
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
      }
      if (chunk.id === EbmlTagId.SimpleBlock) {
        if (firstDecodeEbml) {
          firstDecodeEbml = false;
          console.log(`decoded ebml, simpleblock size:${chunk.size} stream: ${streamName}`);
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

const readTranscripts = async function readTranscripts(
  tsStream,
  callId,
  callerStreamArn,
  sessionId,
) {
  try {
    for await (const event of tsStream) {
      if (event.UtteranceEvent) {
        writeUtteranceEvent(event.UtteranceEvent, callId, callerStreamArn, sessionId);
      }
      if (event.CategoryEvent) {
        writeCategoryEvent(event.CategoryEvent, callId, callerStreamArn, sessionId);
      }
      if (event.TranscriptionEvent) {
        writeTranscriptionSegment(event.TranscriptionEvent, callId, callerStreamArn, sessionId);
      }
    }
  } catch (error) {
    console.error('error writing transcription segment', JSON.stringify(error));
    writeStatusToKds('STEREO', 'TRANSCRIPT_ERROR', callId, callerStreamArn, sessionId);
  } finally {
    // writeStatusToKds('STEREO', 'END_TRANSCRIPT', callId, callerStreamArn, sessionId);
  }
};

const go = async function go(
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
  const audioStream = async function* audioStream() {
    try {
      if (isTCAEnabled) {
        const channel0 = { ChannelId: 0, ParticipantRole: ParticipantRole.AGENT };
        const channel1 = { ChannelId: 1, ParticipantRole: ParticipantRole.CALLER };
        const channelDefinitions = [];
        channelDefinitions.push(channel0);
        channelDefinitions.push(channel1);
        const configurationEvent = { ChannelDefinitions: channelDefinitions };
        yield { ConfigurationEvent: configurationEvent };
      }
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
  let tsStream;
  let tsParams;

  /* configure stream transcription parameters */
  if (isTCAEnabled) {
    tsParams = {
      LanguageCode: 'en-US',
      MediaSampleRateHertz: 8000,
      MediaEncoding: 'pcm',
      // VocabularyName: customVocab,
      // ContentRedactionType: (isRedactionEnabled === 'true') ? contentRedactionType : undefined,
      // PiiEntityTypes: (isRedactionEnabled === 'true') && (contentRedactionType === 'PII')
      //    ? piiEntities : undefined,
      AudioStream: audioStream(),
    };
  } else {
    tsParams = {
      LanguageCode: TRANSCRIBE_LANGUAGE_CODE,
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 8000,
      NumberOfChannels: 2,
      EnableChannelIdentification: true,
      AudioStream: audioStream(),
    };
  }
  /* common optional stream parameters */
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

  /* start the stream */
  let tsResponse;
  if (isTCAEnabled) {
    tsResponse = await tsClient.send(new StartCallAnalyticsStreamTranscriptionCommand(tsParams));
    tsStream = stream.Readable.from(tsResponse.CallAnalyticsTranscriptResultStream);
  } else {
    tsResponse = await tsClient.send(new StartStreamTranscriptionCommand(tsParams));
    tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);
  }

  sessionId = tsResponse.SessionId;
  if (lastAgentFragment === undefined) {
    writeStatusToKds('STEREO', 'START_TRANSCRIPT', callId, callerStreamArn, sessionId);
  } else writeStatusToKds('STEREO', 'CONTINUE_TRANSCRIPT', callId, callerStreamArn, sessionId);

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

// async function handler (event) {
const handler = async function handler(event, context) {
  if (!event.detail.lambdaCount) event.detail.lambdaCount = 0;
  if (event.detail.lambdaCount > 30) {
    console.log('Stopping due to runaway recursive Lambda.');
  }

  console.log(JSON.stringify(event));

  if (EVENT_TYPE[event.detail.streamingStatus] === 'START') await writeCallEventToDynamo(event);

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
    if (event.detail.isCaller === true) {
      callerStreamArn = event.detail.streamArn;
    } else {
      // agentStreamArn = event.detail.streamArn;
      console.log('this is not the caller stream, so return.');
      return;
    }

    let streamResults = await getStreamsFromDynamo(
      event.detail.callId,
      agentStreamArn,
      callerStreamArn,
    );
    console.log(`agent stream:${streamResults.agentStreamArn}`);
    console.log(`caller stream:${streamResults.callerStreamArn}`);

    let loopCount = 0;

    while (
      // eslint-disable-next-line prettier/prettier
      streamResults.agentStreamArn === undefined || streamResults.callerStreamArn === undefined
    ) {
      console.log(loopCount, 'Agent or caller streams not yet available. Sleeping 100ms.');
      await sleep(100);
      streamResults = await getStreamsFromDynamo(
        event.detail.callId,
        agentStreamArn,
        callerStreamArn,
      );
      console.log(`agent stream:${streamResults.agentStreamArn}`);
      console.log(`caller stream:${streamResults.callerStreamArn}`);
      loopCount += 1;
      if (loopCount === 100) {
        console.log('Both KVS streams not active after 10 seconds. Exiting.');
        return;
      }
    }

    // Call customer LambdaHook, if present
    if (LAMBDA_HOOK_FUNCTION_ARN) {
      // invoke lambda function
      // if it fails, just throw an exception and exit
      console.log(`Invoking LambdaHook: ${LAMBDA_HOOK_FUNCTION_ARN}`);
      const invokeCmd = new InvokeCommand({
        FunctionName: LAMBDA_HOOK_FUNCTION_ARN,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(event),
      });
      const lambdaResponse = await lambdaClient.send(invokeCmd);
      const payload = JSON.parse(Buffer.from(lambdaResponse.Payload));
      console.log(`LambdaHook response: ${JSON.stringify(payload)}`);
      if (lambdaResponse.FunctionError) {
        console.log('Lambda failed to run, throwing an exception');
        throw new Error(payload);
      }
      /* Process the response. Payload looks like this:
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

      // Should we process this call?
      if (payload.shouldProcessCall === false) {
        console.log('Lambda hook returned shouldProcessCall=false, exiting.');
        return;
      }
      if (payload.shouldProcessCall === true) {
        console.log('Lambda hook returned shouldProcessCall=true, continuing.');
      }

      // New CallId?
      if (payload.callId) {
        console.log(`Lambda hook returned new callId: "${payload.callId}"`);
        event.detail.callId = payload.callId;
      }

      // Swap caller and agent channels?
      if (payload.isCaller === false) {
        console.log('Lambda hook returned isCaller=false, swapping caller/agent streams');
        [streamResults.agentStreamArn, streamResults.callerStreamArn] = [
          streamResults.callerStreamArn,
          streamResults.agentStreamArn,
        ];
      }
      if (payload.isCaller === true) {
        console.log('Lambda hook returned isCaller=true, caller/agent streams not swapped');
      }

      // AgentId?
      if (payload.agentId) {
        console.log(`Lambda hook returned agentId: "${payload.agentId}"`);
        event.detail.agentId = payload.agentId;
      }

      // New 'to' or 'from' phone numbers?
      if (payload.fromNumber) {
        console.log(`Lambda hook returned fromNumber: "${payload.fromNumber}"`);
        event.detail.fromNumber = payload.fromNumber;
      }
      if (payload.toNumber) {
        console.log(`Lambda hook returned toNumber: "${payload.toNumber}"`);
        event.detail.toNumber = payload.toNumber;
      }
    }

    await writeCallEventToKds(event);

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
      else event.detail.lambdaCount += 1;

      // we need to launch a new one
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(event),
      });
      await lambdaClient.send(invokeCmd);
    } else {
      writeStatusToKds(
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
      await mergeFiles({
        bucketName: OUTPUT_BUCKET,
        recordingPrefix: RECORDING_FILE_PREFIX,
        rawPrefix: RAW_FILE_PREFIX,
        callId: event.detail.callId,
        lambdaCount: event.detail.lambdaCount,
      });
      await writeS3Url(event.detail.callId);
    }
  }
};

exports.handler = handler;
