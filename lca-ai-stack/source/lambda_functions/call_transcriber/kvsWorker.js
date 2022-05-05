/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console */

const { workerData, parentPort } = require('worker_threads');
const process = require('process');
const { EbmlStreamDecoder, EbmlTagId, EbmlTagPosition } = require('ebml-stream');
const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoMedia } = require('@aws-sdk/client-kinesis-video-media');

console.log('inside', workerData.streamName, 'worker');

let timeToStop = false;


parentPort.on('message', (message) => {
  console.log('received message from parent', message);
  timeToStop = true;
});

// Start the stream for this particular stream
const readKVS = async (region, streamName, streamArn, lastFragment) => {
  let actuallyStop = false;
  let firstDecodeEbml = true;

  let lastMessageTime;

  const timeout = setTimeout(() => {
    // Check every 10 seconds if 5 minutes have passed
    if (Date.now() - lastMessageTime > 1000 * 60 * 5) {
      parentPort.postMessage({ type: 'timeout', streamName, lastFragment });
      clearInterval(timeout);
    }
  }, 10000);

  console.log('inside readKVS worker', region, streamName, streamArn);
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
          parentPort.postMessage({ type: 'chunk', chunk: chunk.payload });
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
    parentPort.postMessage({ type: 'lastFragment', streamName, lastFragment });

    process.exit();
  });
  console.log(`Starting stream ${streamName}`);
  const kvClient = new KinesisVideoClient({ region });
  const getDataCmd = new GetDataEndpointCommand({ APIName: 'GET_MEDIA', StreamARN: streamArn });
  const response = await kvClient.send(getDataCmd);
  const mediaClient = new KinesisVideoMedia({ region, endpoint: response.DataEndpoint });
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
};

readKVS(workerData.region, workerData.streamName, workerData.streamArn, workerData.lastFragment);
