/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { PutRecordCommand } = require('@aws-sdk/client-kinesis');
const { CopyObjectCommand } = require('@aws-sdk/client-s3');

// Add a '/' to S3 or HTML paths if needed
const formatPath = function (path) {
  let pathOut = path;
  if (path.length > 0 && path.charAt(path.length - 1) != "/") {
    pathOut += "/";
  }
  return pathOut;
}

const REGION = process.env.REGION || 'us-east-1';
const SAVE_PARTIAL_TRANSCRIPTS = (process.env.SAVE_PARTIAL_TRANSCRIPTS || 'true') === 'true';
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME || '';
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = formatPath(process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/');

const expireInDays = 90;

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};

const writeTranscriptionSegmentToKds = async function writeTranscriptionSegmentToKds(
  kinesisClient,
  transcriptionEvent,
  callId,
) {
  // only write if there is more than 0
  const result = transcriptionEvent.Transcript.Results[0];
  if (!result) return;
  if (result.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS) {
    return;
  }
  const transcript = result.Alternatives[0];
  if (!transcript.Transcript) return;

  console.log('Sending ADD_TRANSCRIPT_SEGMENT event on KDS');

  const channel = result.ChannelId === 'ch_0' ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();
  const eventType = 'ADD_TRANSCRIPT_SEGMENT';

  const putObj = {
    Channel: channel,
    CallId: callId,
    SegmentId: `${result.ChannelId}-${result.StartTime}`,
    StartTime: result.StartTime.toString(),
    EndTime: result.EndTime.toString(),
    Transcript: result.Alternatives[0].Transcript,
    IsPartial: result.IsPartial,
    EventType: eventType.toString(),
    CreatedAt: now,
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

const writeAddTranscriptSegmentEventToKds = async function writeAddTranscriptSegmentEventToKds(
  kinesisClient,
  utteranceEvent,
  transcriptEvent,
  callId,
) {
  if (transcriptEvent) {
    if (transcriptEvent.Transcript?.Results && transcriptEvent.Transcript?.Results.length > 0) {
      if (
        // eslint-disable-next-line operator-linebreak
        transcriptEvent.Transcript?.Results[0].Alternatives &&
        transcriptEvent.Transcript?.Results[0].Alternatives?.length > 0
      ) {
        const result = transcriptEvent.Transcript?.Results[0];
        if (
          // eslint-disable-next-line operator-linebreak
          result.IsPartial === undefined ||
          (result.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS)
        ) {
          return;
        }
      }
    }
  }

  if (utteranceEvent) {
    if (
      // eslint-disable-next-line operator-linebreak
      utteranceEvent.IsPartial === undefined ||
      (utteranceEvent.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS)
    ) {
      return;
    }
  }

  const now = new Date().toISOString();

  const kdsObject = {
    EventType: 'ADD_TRANSCRIPT_SEGMENT',
    CallId: callId,
    TranscriptEvent: transcriptEvent,
    UtteranceEvent: utteranceEvent,
    CreatedAt: now,
    UpdatedAt: now,
  };

  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(kdsObject)),
  };

  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
    console.info('Written ADD_TRANSCRIPT_SEGMENT event to KDS');
    console.info(JSON.stringify(kdsObject));
  } catch (error) {
    console.error('Error writing transcription segment to KDS', error);
    console.debug(JSON.stringify(kdsObject));
  }
};

const writeUtteranceEventToKds = async function writeUtteranceEventToKds(
  kinesisClient,
  utterances,
  callId,
) {
  if (utterances) {
    if (
      utterances.IsPartial === undefined // eslint-disable-line prettier/prettier
      // eslint-disable-next-line prettier/prettier
      || (utterances.IsPartial === true && !SAVE_PARTIAL_TRANSCRIPTS)
    ) {
      return;
    }
    if (utterances.Transcript) {
      const now = new Date().toISOString();
      const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;
      const kdsObject = {
        EventType: 'ADD_TRANSCRIPT_SEGMENT',
        CallId: callId,
        Channel: utterances.ParticipantRole || '',
        SegmentId: utterances.UtteranceId || '',
        StartTime: (utterances.BeginOffsetMillis || 0) / 1000,
        EndTime: (utterances.EndOffsetMillis || 0) / 1000,
        Transcript: utterances.Transcript,
        IsPartial: utterances.IsPartial,
        CreatedAt: now,
        ExpiresAfter: expiration.toString(),
        Sentiment: undefined,
        IssuesDetected: undefined,
      };
      if (utterances.Sentiment) {
        kdsObject.Sentiment = utterances.Sentiment;
      }

      if (utterances.IssuesDetected) {
        kdsObject.IssuesDetected = utterances.IssuesDetected;
      }
      const putParams = {
        StreamName: KINESIS_STREAM_NAME,
        PartitionKey: callId,
        Data: Buffer.from(JSON.stringify(kdsObject)),
      };

      const putCmd = new PutRecordCommand(putParams);
      try {
        await kinesisClient.send(putCmd);
        console.info('Written TCA ADD_TRANSCRIPT_SEGMENT event to KDS');
        console.info(JSON.stringify(kdsObject));
      } catch (error) {
        console.error('Error writing transcription segment (TCA) to KDS', error);
      }
    }
  }
};

const writeCategoryEventToKds = async function writeCategoryEventToKds(
  kinesisClient,
  categoryEvent,
  callId,
) {
  if (categoryEvent) {
    const now = new Date().toISOString();

    const kdsObject = {
      EventType: 'ADD_CALL_CATEGORY',
      CallId: callId,
      CategoryEvent: categoryEvent,
      CreatedAt: now,
    };

    const putParams = {
      StreamName: KINESIS_STREAM_NAME,
      PartitionKey: callId,
      Data: Buffer.from(JSON.stringify(kdsObject)),
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
      await kinesisClient.send(putCmd);
      console.debug('Written ADD_CALL_CATEGORY to KDS');
      console.debug(JSON.stringify(kdsObject));
    } catch (error) {
      console.error('Error writing ADD_CALL_CATEGORY to KDS', error);
      console.debug(JSON.stringify(kdsObject));
    }
  }
};

const writeCallStartEventToKds = async function writeCallStartEventToKds(kinesisClient, callData) {
  console.log('Write Call Start Event to KDS');
  const putObj = {
    CallId: callData.callId,
    CreatedAt: new Date().toISOString(),
    CustomerPhoneNumber: callData.fromNumber,
    SystemPhoneNumber: callData.toNumber,
    AgentId: callData.agentId,
    Metadatajson: callData.metadatajson,
    EventType: 'START',
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callData.callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log('Sending Call START event on KDS: ', JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call START event', error);
  }
};

const writeCallEndEventToKds = async function writeCallEndEventToKds(kinesisClient, callId) {
  console.log('Write Call End Event to KDS');
  const putObj = {
    CallId: callId,
    EventType: 'END',
  };
  const putParams = {
    StreamName: KINESIS_STREAM_NAME,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log('Sending Call END event on KDS: ', JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call END', error);
  }
};

const writeS3UrlToKds = async function writeS3UrlToKds(kinesisClient, callId) {
  console.log('Writing S3 URL To KDS');
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
  console.log('Sending ADD_S3_RECORDING_URL event on KDS: ', JSON.stringify(putObj));
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing ADD_S3_RECORDING_URL event', error);
  }
};

exports.formatPath = formatPath;
exports.writeS3UrlToKds = writeS3UrlToKds;
exports.writeTranscriptionSegmentToKds = writeTranscriptionSegmentToKds;
exports.writeCallStartEventToKds = writeCallStartEventToKds;
exports.writeCallEndEventToKds = writeCallEndEventToKds;
exports.writeUtteranceEventToKds = writeUtteranceEventToKds;
exports.writeCategoryEventToKds = writeCategoryEventToKds;
exports.writeAddTranscriptSegmentEventToKds = writeAddTranscriptSegmentEventToKds;

