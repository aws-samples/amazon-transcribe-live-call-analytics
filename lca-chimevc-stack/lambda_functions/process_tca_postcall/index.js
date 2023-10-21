/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

// Add a '/' to S3 or HTML paths if needed
const formatPath = function(path) {
  let pathOut = path;
  if (path.length > 0 && path.charAt(path.length - 1) != "/") {
    pathOut += "/";
  }
  return pathOut;
};

const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { KinesisClient, PutRecordCommand } = require('@aws-sdk/client-kinesis');
const REGION = process.env.REGION || 'us-east-1';
const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const kinesisClient = new KinesisClient({ region: REGION });

const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME || '';
const TRANSCRIBER_CALL_EVENT_TABLE_NAME = process.env.TRANSCRIBER_CALL_EVENT_TABLE_NAME || '';
const LCA_BUCKET_NAME = process.env.LCA_BUCKET_NAME || '';
const CALL_ANALYTICS_FILE_PREFIX = formatPath(process.env.CALL_ANALYTICS_FILE_PREFIX || 'lca-call-analytics/');
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const USED_CHIME_CALL_ANALYTICS = (process.env.USED_CHIME_CALL_ANALYTICS || 'true') === 'true';

function getAnalyticsOutputBucketAndKey(sessionId, suffix) {
  const analyticsfolder = (IS_CONTENT_REDACTION_ENABLED) ? "redacted-analytics/" : "analytics/";
  const buckeyAndKey = {
    Key: `${CALL_ANALYTICS_FILE_PREFIX}${analyticsfolder}${sessionId}${suffix}`,
    Bucket: `${LCA_BUCKET_NAME}`,
  }
  return buckeyAndKey;
}

const getSessionDataFromDdb = async function getSessionDataFromDdb(dynamoClient, sessionId) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `sd#${sessionId}`,
      },
      SK: {
        S: 'TRANSCRIBE SESSION',
      },
    },
    TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
  };
  console.log('GetItem params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let sessionData;
  try {
    const data = await dynamoClient.send(command);
    console.log('GetItem result: ', JSON.stringify(data));
    sessionData = JSON.parse(data.Item.SessionData.S);
  } catch (error) {
    console.log('Error retrieving sessionData - Possibly invalid sessionId?: ', error);
  }
  return sessionData;
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

const writeS3UrlToKds = async function writeS3UrlToKds(kinesisClient, callId, recordingUrl) {
  console.log('Writing S3 URL To KDS');
  const now = new Date().toISOString();
  const eventType = 'ADD_S3_RECORDING_URL';
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

const readFileFromS3 = async function readFileFromS3(bucketAndKey) {
  console.log("reading file: ", bucketAndKey)
  try {
    const response = await s3Client.send(new GetObjectCommand(bucketAndKey));
    return await response.Body.transformToString();
  } catch (err) {
    console.error('S3 read error: ', err); 
    return "{}";  
  }
}

function filterCategories(categories) {
  let filteredCategories = {
    "MatchedDetails": {},
    "MatchedCategories": []
  }
  // only include POST_CALL categories
  let categoryName;
  for (let i = 0; i < categories.MatchedCategories.length; i++) {
    categoryName = categories.MatchedCategories[i];
    if (categories.MatchedDetails[categoryName].CategoryType == "POST_CALL") {
      filteredCategories.MatchedDetails[categoryName] = categories.MatchedDetails[categoryName];
      filteredCategories.MatchedCategories.push(categoryName);
    }
  }
  return filteredCategories;
}

const parseBucketAndKey = function(s3Uri) {
  const s3UriMatch = s3Uri.match(/s3:\/\/([^\/]+)\/(.*)/);
  return  {
    Key: s3UriMatch[2],
    Bucket: s3UriMatch[1],
  };
}

const processRecordingFile = async function processRecordingFile(s3Client, event, sessionData) {
  if (!USED_CHIME_CALL_ANALYTICS) {
    console.log("Skip Writing ADD_S3_RECORDING_URL event To KDS for non Chime SDK Call Analytics");
    return;
  }

  let bucketAndKey = undefined;
  if (IS_CONTENT_REDACTION_ENABLED) {
    if (event.detail.Transcript && event.detail.Media.RedactedMediaFileUri) {
      bucketAndKey = parseBucketAndKey(event.detail.Media.RedactedMediaFileUri);
    }
  } else {
    if (event.detail.Transcript && event.detail.Media.MediaFileUri) {
      bucketAndKey = parseBucketAndKey(event.detail.Media.MediaFileUri);
    }
  }

  if (bucketAndKey === undefined) {
    bucketAndKey = getAnalyticsOutputBucketAndKey(sessionData.sessionId, '.wav');
  }

  console.log("Writing ADD_S3_RECORDING_URL event To KDS");
  const encodedKey = bucketAndKey.Key.split("/").map(part => encodeURIComponent(part)).join('/');
  const recordingUrl = `https://${bucketAndKey.Bucket}.s3.${REGION}.amazonaws.com/${encodedKey}`;
  await writeS3UrlToKds(kinesisClient, sessionData.callId, recordingUrl);
}

const processTranscriptFile = async function processTranscriptFile(s3Client, event, sessionData) {
  let bucketAndKey = undefined;
  if (IS_CONTENT_REDACTION_ENABLED) {
    if (event.detail.Transcript && event.detail.Transcript.RedactedTranscriptFileUri) {
      bucketAndKey = parseBucketAndKey(event.detail.Transcript.RedactedTranscriptFileUri);
    }
  } else {
    if (event.detail.Transcript && event.detail.Transcript.TranscriptFileUri) {
      bucketAndKey = parseBucketAndKey(event.detail.Transcript.TranscriptFileUri);
    }
  }

  if (bucketAndKey === undefined) {
    bucketAndKey = getAnalyticsOutputBucketAndKey(sessionData.sessionId, '.json');
  }

  const analytics = JSON.parse(await readFileFromS3(bucketAndKey));
  // Categories
  if (analytics.Categories) {
    const filteredCategories = filterCategories(analytics.Categories);
    if (filteredCategories.MatchedCategories.length > 0) {
      await writeCategoryEventToKds(kinesisClient, filteredCategories, sessionData.callId);
    } else {
      console.log("No POST_CALL categories identified for call")
    }
  }
}

const handler = async function handler(event, context) {
  console.log("Event: ", JSON.stringify(event));
  const sessionId = event.detail.StreamingSessionId;
  let job_completed = true;
  if (event.detail.PostCallStatus != "COMPLETED" && event.detail.PostStreamStatus != "COMPLETED") {
    console.log("ERROR Job failed - Failure reason:", event.detail.FailureReason);
    job_completed = false;
  }

  const sessionData = await getSessionDataFromDdb(dynamoClient, sessionId);
  if (!sessionData) {
    console.log("ERROR: Can't continue - no sessionData found.");
  }

  if (!job_completed) {
    console.log("ERROR: Can't continue - transcribe post call job failed.");
  }

  if (sessionData && job_completed) {
    await processTranscriptFile(s3Client, event, sessionData);
    await processRecordingFile(s3Client, event, sessionData);
  }
};

exports.handler = handler;

// Test
/*
const event={
  "version": "0",
  "id": "0de5438d-bf86-c04c-7441-1f4c4eff1798",
  "detail-type": "Call Analytics Post Call Job State Change",
  "source": "aws.transcribe",
  "account": "912625584728",
  "time": "2023-02-19T23:41:51Z",
  "region": "us-east-1",
  "resources": [],
  "detail": {
      "Transcript": {
          "TranscriptFileUri": "s3://lca-aa-asterisk-aistack-1jov74e6-recordingsbucket-ds31m0sugh17/lca-call-analytics/analytics/360a9eb8-9eee-460e-b444-b46e70f641b4.json"
      },
      "PostCallStatus": "COMPLETED",
      "StreamingSessionId": "360a9eb8-9eee-460e-b444-b46e70f641b4",
      "Media": {
          "MediaFileUri": "s3://lca-aa-asterisk-aistack-1jov74e6-recordingsbucket-ds31m0sugh17/lca-call-analytics/analytics/360a9eb8-9eee-460e-b444-b46e70f641b4.wav"
      }
  }
}

//export KINESIS_STREAM_NAME='LCA-AA-Asterisk-AISTACK-1JOV74E6CRV7K-CallDataStream-dF6h3ac1d3xl';
//export TRANSCRIBER_CALL_EVENT_TABLE_NAME='LCA-AA-Asterisk-CHIMEVCSTACK-Q5B3LOV32VYX-DeployCallTranscriber-K0KRQLW8E9N5-TranscriberCallEventTable-VWVQC1NTV3IF';
//export LCA_BUCKET_NAME='lca-aa-asterisk-aistack-1jov74e6-recordingsbucket-ds31m0sugh17';
//export CALL_ANALYTICS_FILE_PREFIX='lca-call-analytics/');
//export IS_CONTENT_REDACTION_ENABLED='false';

handler(event);
*/