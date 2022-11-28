/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const fs = require('fs');

const REGION = process.env.REGION || 'us-east-1';
const s3Client = new S3Client({ region: REGION });
const tempFilePath = process.env.TEMP_FILE_PATH || '/tmp/';
const bitDepth = 16;
const bytesPerSample = bitDepth / 8;
const outSampleRate = 8000;
const outNumChannels = 2;

// based on https://github.com/mattdiamond/Recorderjs/blob/master/src/recorder.js
const createHeader = function createHeader(length) {
  const buffer = Buffer.alloc(44);

  // RIFF identifier 'RIFF'
  buffer.writeUInt32BE(1380533830, 0);
  // file length minus RIFF identifier length and file description length
  buffer.writeUInt32LE(36 + length, 4);
  // RIFF type 'WAVE'
  buffer.writeUInt32BE(1463899717, 8);
  // format chunk identifier 'fmt '
  buffer.writeUInt32BE(1718449184, 12);
  // format chunk length
  buffer.writeUInt32LE(16, 16);
  // sample format (raw)
  buffer.writeUInt16LE(1, 20);
  // channel count
  buffer.writeUInt16LE(outNumChannels, 22);
  // sample rate
  buffer.writeUInt32LE(outSampleRate, 24);
  // byte rate (sample rate * block align)
  buffer.writeUInt32LE(outSampleRate * bytesPerSample * outNumChannels, 28);
  // block align (channel count * bytes per sample)
  buffer.writeUInt16LE(bytesPerSample * outNumChannels, 32);
  // bits per sample
  buffer.writeUInt16LE(bitDepth, 34);
  // data chunk identifier 'data'
  buffer.writeUInt32BE(1684108385, 36);
  buffer.writeUInt32LE(length, 40);

  return buffer;
};

const mergeFiles = async function mergeFiles(event) {
  let totalSize = 0;
  const combinedRawFilename = `${tempFilePath + event.callId}-combined.raw`;
  const combinedWavFilename = `${tempFilePath + event.callId}.wav`;
  const combinedStream = fs.createWriteStream(combinedRawFilename);

  // download and write each file to the stream
  for (let i = 0; i <= event.lambdaCount; i += 1) {
    const key = `${event.rawPrefix + event.callId}-${i}.raw`;
    console.log(`Downloading ${key}`);
    const bucketParams = {
      Bucket: event.bucketName,
      Key: key,
    };

    // eslint-disable-next-line no-await-in-loop
    const data = await s3Client.send(new GetObjectCommand(bucketParams));
    // eslint-disable-next-line no-restricted-syntax, no-await-in-loop
    for await (const chunk of data.Body) {
      totalSize += chunk.length;
      combinedStream.write(chunk);
    }
  }
  combinedStream.end();

  console.log('Creating header');
  const header = createHeader(totalSize);
  console.log('Creating merged file');
  const readStream = fs.createReadStream(combinedRawFilename);
  const writeStream = fs.createWriteStream(combinedWavFilename);
  console.log('Writing header');
  writeStream.write(header);
  console.log('Writing body chunks');
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of readStream) {
    writeStream.write(chunk);
  }
  writeStream.end();

  console.log('Uploading merged file.');
  const readWavStream = fs.createReadStream(combinedWavFilename);

  // upload back to s3
  // Set the parameters
  const uploadParams = {
    Bucket: event.bucketName,
    // Add the required 'Key' parameter using the 'path' module.
    Key: `${event.recordingPrefix + event.callId}.wav`,
    // Add the required 'Body' parameter
    Body: readWavStream,
  };
  const data = await s3Client.send(new PutObjectCommand(uploadParams));
  console.log('Deleting old files');
  // delete old files
  for (let i = 0; i <= event.lambdaCount; i += 1) {
    const key = `${event.rawPrefix + event.callId}-${i}.raw`;
    console.log(`Deleting ${key}`);
    const bucketParams = {
      Bucket: event.bucketName,
      Key: key,
    };
    // eslint-disable-next-line no-await-in-loop
    await s3Client.send(new DeleteObjectCommand(bucketParams));
  }

  console.log('Done', data);
};

exports.mergeFiles = mergeFiles;
