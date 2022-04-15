/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable import/no-unresolved, no-console */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const { EVENT_SOURCING_TABLE_NAME, EXPIRATION_IN_DAYS, AWS_REGION } = process.env;
const DDB_CLIENT = new DynamoDBClient({ region: AWS_REGION });
const DDB_DOC_CLIENT = DynamoDBDocumentClient.from(DDB_CLIENT);

// eslint-disable-next-line no-unused-vars
exports.handler = async (event, context) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Get the object from the event and show its content type
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
  // set the download URL
  const url = new URL(key, `https://${bucket}.s3.${AWS_REGION}.amazonaws.com`);
  const recordingUrl = url.href;

  const [, filename] = key.split('/');
  const [callId] = filename.split('.');
  console.log(`Received event for this call ID: ${callId}`);

  const now = new Date();
  const currentTimeStamp = now.toISOString();
  const expiresAfter = Math.ceil(
    (Number(now) + Number(EXPIRATION_IN_DAYS) * 24 * 3600 * 1000) / 1000,
  );

  const eventType = 'ADD_S3_RECORDING_URL';
  const item = {
    PK: `ce#${callId}`,
    SK: `ts#${currentTimeStamp}#et#${eventType}`,
    CallId: callId,
    ExpiresAfter: expiresAfter,
    CreatedAt: currentTimeStamp,
    RecordingUrl: recordingUrl,
    EventType: eventType,
  };
  console.debug('putting dynamoDB item', JSON.stringify(item, null, 2));
  const putCommand = new PutCommand({
    TableName: EVENT_SOURCING_TABLE_NAME,
    Item: item,
    ReturnValues: 'ALL_OLD',
  });

  try {
    const response = await DDB_DOC_CLIENT.send(putCommand);
    console.debug(response);
  } catch (error) {
    console.error('failed to send event');
  }
};
