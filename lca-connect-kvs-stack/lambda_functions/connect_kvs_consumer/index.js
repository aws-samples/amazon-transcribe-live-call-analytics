/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { S3Client, PutObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
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
const TRANSCRIBER_CALL_EVENT_TABLE_NAME = process.env.TRANSCRIBER_CALL_EVENT_TABLE_NAME || '';
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || '';
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
const CONNECT_INSTANCE_ARN = process.env.CONNECT_INSTANCE_ARN || '';

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
const TIMEOUT = parseInt(process.env.LAMBDA_INVOKE_TIMEOUT, 10) || 720000;

let s3Client;
let lambdaClient;
// eslint-disable-next-line no-unused-vars
let kinesisClient;

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

// eslint-disable-next-line max-len
const getCallDataFromContactFlowEvent = async function getCallDataFromContactFlowEvent(contactFlowEvent) {
  const now = new Date().toISOString();
  const streamArn = contactFlowEvent.Details.ContactData.MediaStreams.Customer.Audio.StreamARN;
  const callId = contactFlowEvent.Details.ContactData.ContactId;
  const fromNumber = contactFlowEvent.Details.ContactData.CustomerEndpoint.Address;
  const toNumber = contactFlowEvent.Details.ContactData.SystemEndpoint.Address;
  let agentId = '';
  if (contactFlowEvent.Details.ContactData.Attributes?.AgentId !== undefined) {
    agentId = contactFlowEvent.Details.ContactData.Attributes.AgentId;
  }
  const callData = {
    callId,
    originalCallId: contactFlowEvent.Details.ContactData.InitialContactId,
    callStreamingStartTime: now,
    callProcessingStartTime: now,
    callStreamingEndTime: '',
    shouldProcessCall: true,
    shouldRecordCall: true,
    fromNumber,
    toNumber,
    agentId: agentId,
    metadatajson: undefined,
    callerStreamArn: streamArn,
    agentStreamArn: streamArn,
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
}

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

const readStereoKVS = async (streamArn, lastFragment, callerStream, agentStream) => {
  let actuallyStop = false;
  let firstDecodeEbml = true;
  let totalSize = 0;
  let lastMessageTime;
  let currentTrack;
  let currentTrackName;
  let trackDictionary = {};

  console.log('inside readKVS worker', REGION, streamArn);
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
      if (chunk.id === EbmlTagId.TrackNumber) {
        console.log('TrackNumber', chunk.data);
        currentTrack = parseInt(chunk.data);
      }
      if (chunk.id === EbmlTagId.Name) {
        console.log('TrackName', chunk.data);
        currentTrackName = chunk.data;
        if (currentTrack && currentTrackName) {
          trackDictionary[currentTrack] = currentTrackName;
        }
      }
      if (chunk.id === EbmlTagId.SimpleTag) {
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_FRAGMENT_NUMBER') {
          lastFragment = chunk.Children[1].data;
        }
        // capture latest audio timestamps for stream in global variable
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_SERVER_TIMESTAMP') {
          kvsServerTimestamp['Server'] = chunk.Children[1].data;
        }
        if (chunk.Children[0].data === 'AWS_KINESISVIDEO_PRODUCER_TIMESTAMP') {
          kvsProducerTimestamp['Producer'] = chunk.Children[1].data;
        }
      }
      if (chunk.id === EbmlTagId.SimpleBlock) {
        if (firstDecodeEbml) {
          firstDecodeEbml = false;
          console.log(`decoded ebml, simpleblock size:${chunk.size}`);
          console.log(
            `stream - producer timestamp: ${kvsProducerTimestamp['Producer']}, server timestamp: ${kvsServerTimestamp['Server']}`,
          );
          timestampDeltaCheck(1);
        }
        try {
          if (trackDictionary[chunk.track] === 'AUDIO_TO_CUSTOMER') agentStream.write(chunk.payload);
          if (trackDictionary[chunk.track] === 'AUDIO_FROM_CUSTOMER') callerStream.write(chunk.payload);
        } catch (error) {
          console.error('Error posting payload chunk', error);
        }
      }
    }
  }); // use this to find last fragment tag we received
  decoder.on('end', () => {
    // close stdio
    console.log('Finished');
    console.log(`Last fragment ${lastFragment} total size: ${totalSize}`);
  });
  console.log('Starting stream');
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
        console.log(`received chunk size: ${chunk.length}`);
      }
      totalSize += chunk.length;
      decoder.write(chunk);
      if (actuallyStop) break;
    }
  } catch (error) {
    console.error('error writing to decoder', error);
  } finally {
    console.log('Closing buffers');
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
    console.error('Error processing transcribe stream. SessionId: ', sessionId, error);
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
    lastFragment,
    tcaOutputLocation,
    lambdaCount,
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
        console.log('Sending TCA configuration event');
        console.log(JSON.stringify(configurationEvent));
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
      console.log('Error reading passthrough stream or yielding audio chunk. SessionId: ', sessionId, error);
    }
  };

  const tempRecordingFilename = `${callId}-${lambdaCount}.raw`;
  const writeRecordingStream = fs.createWriteStream(TEMP_FILE_PATH + tempRecordingFilename);

  let tsClientArgs = { region: REGION };
  if (TRANSCRIBE_ENDPOINT) {
    console.log("Using custom Transcribe endpoint:", TRANSCRIBE_ENDPOINT);
    tsClientArgs.endpoint = TRANSCRIBE_ENDPOINT;
  }
  console.log("Transcribe client args:", tsClientArgs);
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

  /* common optional stream parameters */
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
      console.log(`StartStream threw exception on attempt ${retryCount} of ${START_STREAM_MAX_RETRIES}: `, e);
      if (++retryCount > START_STREAM_MAX_RETRIES) throw e;
      sleep(START_STREAM_RETRY_WAIT_MS);
    }
  }

  sessionId = tsResponse.SessionId;
  console.log('Transcribe SessionId: ', sessionId);
  console.log('creating readable from transcript stream');
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
  interleave([callerBlock, agentBlock]).pipe(combinedStream);
  console.log('starting workers');
  const callerWorker = readStereoKVS(callerStreamArn, lastFragment, callerBlock, agentBlock);

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

  const transcribePromise = readTranscripts(tsStream, callId, sessionId);

  const returnVals = await Promise.all([callerWorker]);

  // we are done with transcribe.
  passthroughStream.end();

  await transcribePromise;

  console.log('Done with all 3 streams');
  console.log('Last Caller Fragment: ', returnVals[0]);

  // stop the timer so when we finish and upload to s3 this doesnt kick in
  if (timeToStop === false) {
    clearTimeout(stopTimer);
    timeToStop = false;
  }

  writeRecordingStream.end();

  return {
    agentStreamArn,
    callerStreamArn,
    lastFragment: returnVals[0],
    sessionId,
    tempFileName: tempRecordingFilename,
  };
};


// MAIN LAMBDA HANDLER - FUNCTION ENTRY POINT
const handler = async function handler(event, context) {
  console.log('Event: ', JSON.stringify(event));

  if (event.Details.ContactData.InstanceARN !== CONNECT_INSTANCE_ARN) {
    console.log('Wrong Amazon Connect instance.');
    return {
      'statusCode': 500,
      'body': 'Wrong Amazon Connect Instance'
    };
  }

  s3Client = new S3Client({ region: REGION });
  lambdaClient = new LambdaClient({ region: REGION });
  kinesisClient = new KinesisClient({ region: REGION });

  let callData;

  if (event.action === 'LAMBDA_CONTINUE') {
    callData = event.callData;
    console.log(
      '--- CONTINUING FROM PREVIOUS LAMBDA. LAMBDA SEQUENCE COUNT: ',
      callData.lambdaCount,
      '---',
    );
    if (callData.lambdaCount > 30) {
      console.log('Stopping due to runaway recursive Lambda.');
      return;
    }
  } else if (event.Name === 'ContactFlowEvent' && event.Details.ContactData.Channel === 'VOICE') {
    console.log('Amazon Connect stream STARTED event received.');
    callData = await getCallDataFromContactFlowEvent(event);
    if (callData.shouldProcessCall === false) {
      console.log('CallData shouldProcessCall is false, exiting.');
      return;
    }
    console.log('Ready to start processing call');
    await writeCallStartEventToKds(kinesisClient, callData);
  } else {
    console.log(
      `Amazon Connect stream status ${event.detail.streamingStatus}: Nothing to do - exiting`,
    );
    return;
  }

  if (!callData) {
    console.log('Nothing to do - exiting');
    return;
  }

  console.log('CallData: ', JSON.stringify(callData));
  const result = await go(callData);
  if (result) {
    if (timeToStop) {
      console.log(
        'Lambda approaching max execution time. Starting a new Lambda to continue processing the call.',
      );
      const newEvent = {};
      newEvent.action = 'LAMBDA_CONTINUE';
      newEvent.callData = callData;
      newEvent.callData.lastAgentFragment = result.lastAgentFragment;
      newEvent.callData.lastCallerFragment = result.lastCallerFragment;
      newEvent.callData.sessionId = result.sessionId;
      newEvent.callData.lambdaCount = callData.lambdaCount + 1;
      console.log('Launching new Lambda with event: ', JSON.stringify(newEvent));
      const invokeCmd = new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify(newEvent),
      });
      await lambdaClient.send(invokeCmd);
    } else {
      // Call has ended
      await writeCallEndEventToKds(kinesisClient, callData.callId);
      callData.callStreamingEndTime = new Date().toISOString();
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
          console.log('Error merging S3 recording files:', error);
        }
        await writeS3UrlToKds(kinesisClient, callData.callId);
      }
    }
  }
};

exports.handler = handler;