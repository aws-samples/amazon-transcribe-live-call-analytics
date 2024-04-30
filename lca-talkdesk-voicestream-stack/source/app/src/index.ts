// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws'; // type structure for the websocket object used by fastify/websocket
import stream from 'stream';

import os from 'os';
import fs from 'fs';
import path from 'path';

import {
    MediaStreamConnectedMessage,
    MediaStreamMediaMessage,
    MediaStreamStartMessage,
    MediaStreamStopMessage,
    MediaStreamMessage,
    isConnectedEvent,
    isStartEvent,
    isStopEvent,
    isMediaEvent,
} from './mediastream';

import {  
    CallMetaData, 
    startTranscribe, 
    writeCallStartEvent,
    writeCallEndEvent,
    writeCallEvent,
    CallRecordingEvent,
} from './calleventdata';

import {
    ulawToL16,
    msToBytes,
    createWavHeader,
    deleteTempFile,

} from './utils';

import { randomUUID } from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

let tempRecordingFilename: string;
let wavFileName: string;
let recordingFileSize = 0;
let writeRecordingStream: fs.WriteStream;

let audioInputStream: stream.PassThrough; // audio chunks are written to this stream for Transcribe SDK to consume

let inboundPayloads: Uint8Array[] = []; // inbound audio chunks are stored in this array
let outboundPayloads: Uint8Array[] = []; // outbound audio chunks are stored in this array

let inboundTimestamps: number[] = [];
let outboundTimestamps: number[] = [];

const CPU_HEALTH_THRESHOLD = parseInt(process.env['CPU_HEALTH_THRESHOLD'] || '50', 10);

// const CHUNK_SIZE_IN_MS = 200;
const TWILIO_CHUNK_SIZE_IN_MS = 20;

const SAMPLE_RATE = 8000;
const MULAW_BYTES_PER_SAMPLE = 1;
// const PCML16_BYTES_PER_SAMPLE = 2;

const isDev = process.env['NODE_ENV'] !== 'PROD';
const LOCAL_TEMP_DIR = process.env['LOCAL_TEMP_DIR'] || '/tmp/';
const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || undefined;
const RECORDING_FILE_PREFIX = process.env['RECORDING_FILE_PREFIX'] || 'lca-audio-wav/';

const s3Client = new S3Client({ region: AWS_REGION });

// create fastify server (with logging enabled for non-PROD environments)
const server = fastify({
    logger: {
        prettyPrint: isDev ? {
            translateTime: 'SYS:HH:MM:ss.l',
            colorize: true,
            ignore: 'pid,hostname'
        } : false,
    },
});
// register the @fastify/websocket plugin with the fastify server
server.register(websocket);

// Setup Route for websocket connection
server.get('/api/v1/ws', { websocket: true, logLevel: 'debug' }, (connection, request) => {
    server.log.info(`Websocket Request - URI: <${request.url}>, SocketRemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers, null, 1)}`);

    registerHandlers(connection.socket); // setup the handler functions for websocket events
});

// Setup Route for health check 
server.get('/health/check', { logLevel: 'warn' }, (request, response) => {
    const cpuUsage = os.loadavg()[0] / os.cpus().length * 100;

    const isHealthy = cpuUsage > CPU_HEALTH_THRESHOLD ? false : true;
    const status = isHealthy ? 200 : 503;

    response
        .code(status)
        .header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate')
        .send({ 'Http-Status': status, 'Healthy': isHealthy });
});

// Setup handlers for websocket events - 'message', 'close', 'error'
const registerHandlers = (ws: WebSocket): void => {

    ws.on('message', (data): void => {        
        try {
            const message: MediaStreamMessage = JSON.parse(Buffer.from(data as Uint8Array).toString('utf8'));

            if (isConnectedEvent(message.event)) {
                onConnected(message as MediaStreamConnectedMessage);
            } else if (isStartEvent(message.event)) {
                onStart(message as MediaStreamStartMessage);
            } else if (isMediaEvent(message.event)) {
                onMedia(message as MediaStreamMediaMessage);
            } else if (isStopEvent(message.event)) {
                onStop(message as MediaStreamStopMessage);
            } else {
                server.log.error(`Error processing message: Invalid Event Type ${JSON.stringify(message)}`);
                process.exit(1);
            }

        } catch (error) {
            server.log.error(`registerHandler: Error ${error}`);
            process.exit(1);
        }
    });

    ws.on('close', (code: number) => {
        try {
            onWsClose(ws, code);
        } catch (err) {
            server.log.error('Error in WS close handler: ', err);
        }
    });

    ws.on('error', (error: Error) => {
        server.log.error('Websocket error, forcing close: ', error);
        ws.close();
    });
};

const onConnected = (data: MediaStreamConnectedMessage): void => {
    server.log.info(`Client connected: ${JSON.stringify(data)}`);
};

const onStart = (data: MediaStreamStartMessage): void => {
    server.log.info(`Received Start event from client :  ${JSON.stringify(data)}`);

    const callMetaData: Partial<CallMetaData> = {}; // metadata for the current call
    callMetaData.callEvent = 'START';
    callMetaData.callId = data.start.callSid;
    callMetaData.fromNumber = data.start.customParameters.participant;
    callMetaData.toNumber = 'System Phone';
    callMetaData.shouldRecordCall = false;
    callMetaData.samplingRate = 8000;
    callMetaData.agentId = randomUUID();

    (async () => {
        await writeCallStartEvent(callMetaData as CallMetaData);
        tempRecordingFilename = `${callMetaData.callId}.raw`;
        wavFileName = `${callMetaData.callId}.wav`;
        writeRecordingStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
        recordingFileSize = 0;
        tempRecordingFilename = `${callMetaData.callId}.raw`;
        wavFileName = `${callMetaData.callId}.wav`;
        writeRecordingStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, tempRecordingFilename));
        recordingFileSize = 0;
    })();
    
    audioInputStream = new stream.PassThrough();
    startTranscribe(callMetaData as CallMetaData, audioInputStream);
};

function interleave(left: Uint8Array, right: Uint8Array): Int16Array {

    const left16Bit = ulawToL16(left);
    const right16Bit = ulawToL16(right);

    const length = left16Bit.length + right16Bit.length;
    const interleaved = new Int16Array(length);

    for (let i = 0, j = 0; i < length; j += 1) {
        interleaved[(i += 1)] = left16Bit[j];
        interleaved[(i += 1)] = right16Bit[j];
    }
    return interleaved;
}

function syncTracksAndInterleave(): Uint8Array {

    let startInboundTS = Infinity;
    let endInboundTS = 0 ;
    let startOutboundTS = Infinity;
    let endOutboundTS = 0; 

    // [0] will always be min, [-1] will always be max. No need to use min/max math functions
    if (inboundTimestamps.length > 0) {
        startInboundTS = inboundTimestamps[0];
        endInboundTS = inboundTimestamps[inboundTimestamps.length - 1] + TWILIO_CHUNK_SIZE_IN_MS;
    }
    if (outboundTimestamps.length > 0) {
        startOutboundTS = outboundTimestamps[0];
        endOutboundTS = outboundTimestamps[outboundTimestamps.length - 1] + TWILIO_CHUNK_SIZE_IN_MS;
    }
    const bufferStartTS = Math.min(startInboundTS, startOutboundTS);
    const bufferEndTS = Math.max(endInboundTS, endOutboundTS);
    const bufferLength = msToBytes((bufferEndTS - bufferStartTS + 1), SAMPLE_RATE, MULAW_BYTES_PER_SAMPLE);
    server.log.info(`Buffer Start TS: ${bufferStartTS} End TS : ${bufferEndTS} Length Bytes: ${bufferLength}`);
    
    const inboundBuffer = new Uint8Array(bufferLength).fill(0);
    const outboundBuffer = new Uint8Array(bufferLength).fill(0); 

    if (inboundPayloads.length > 0) {
        const inboundPayload = Buffer.concat(inboundPayloads);
        const offsetTS = startInboundTS - bufferStartTS;
        const byteOffset = msToBytes(offsetTS, SAMPLE_RATE, MULAW_BYTES_PER_SAMPLE);
        server.log.info(`inbound offset: TS ${offsetTS} Byte: ${byteOffset}`);
        inboundBuffer.set(inboundPayload, byteOffset);
    }
    if (outboundPayloads.length > 0 ) {
        const outboundPayload = Buffer.concat(outboundPayloads);
        const offsetTS = startOutboundTS - bufferStartTS;
        const byteOffset = msToBytes(offsetTS, SAMPLE_RATE, MULAW_BYTES_PER_SAMPLE);
        server.log.info(`outbound offset: TS ${offsetTS} Byte: ${byteOffset}`);
        outboundBuffer.set(outboundPayload, byteOffset);
    }
    
    const interleaved = interleave(inboundBuffer, outboundBuffer);
    const chunk = new Uint8Array(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
    return chunk;

}

const onMedia = (data: MediaStreamMediaMessage): void => {
    server.log.info(`Received Media event from client :  ${JSON.stringify(data)}`);

    const ulawBuffer = Buffer.from(data.media.payload, 'base64');

    if (data.media.track == 'inbound') {
        inboundPayloads.push(ulawBuffer);
        inboundTimestamps.push(parseInt(data.media.timestamp));
    } else if (data.media.track == 'outbound') {
        outboundPayloads.push(ulawBuffer);
        outboundTimestamps.push(parseInt(data.media.timestamp));
    }

    if (parseInt(data.sequenceNumber) % 20 === 0) {

        const interleaved = syncTracksAndInterleave();
        if (audioInputStream) {
            audioInputStream.write(interleaved);
            writeRecordingStream.write(interleaved);
            recordingFileSize += interleaved.length;
        }

        inboundPayloads = [];
        outboundPayloads = [];    
        inboundTimestamps = [];
        outboundTimestamps = [];
    }

};

const writeToS3 = async (tempFileName:string) => {
    const sourceFile = path.join(LOCAL_TEMP_DIR, tempFileName);

    console.log('Uploading audio to S3');
    let data;
    const fileStream = fs.createReadStream(sourceFile);
    const uploadParams = {
        Bucket: RECORDINGS_BUCKET_NAME,
        Key: RECORDING_FILE_PREFIX + tempFileName,
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

const onStop = (data: MediaStreamStopMessage): void => {
    server.log.info(`Received Stop event from client :  ${JSON.stringify(data)}`);

    const interleaved = syncTracksAndInterleave();
    if (audioInputStream) {
        audioInputStream.write(interleaved);
        writeRecordingStream.write(interleaved);
        recordingFileSize += interleaved.length;
    }

    inboundPayloads = [];
    outboundPayloads = [];    
    inboundTimestamps = [];
    outboundTimestamps = [];

    const callMetaData: Partial<CallMetaData> = {}; // metadata for the current call
    callMetaData.callEvent = 'END';
    callMetaData.callId = data.stop.callSid;
    callMetaData.fromNumber = 'Participant Phone';
    callMetaData.toNumber = 'System Phone';
    callMetaData.shouldRecordCall = true;
    callMetaData.samplingRate = 8000;
    callMetaData.agentId = randomUUID();

    (async () => {
        await writeCallEndEvent(callMetaData as CallMetaData);
        writeRecordingStream.end();

        const header = createWavHeader(recordingFileSize, callMetaData.samplingRate || 8000);
        const readStream = fs.createReadStream(path.join(LOCAL_TEMP_DIR,tempRecordingFilename));
        const writeStream = fs.createWriteStream(path.join(LOCAL_TEMP_DIR, wavFileName));
        writeStream.write(header);
        for await (const chunk of readStream) {
            writeStream.write(chunk);
        }
        writeStream.end();

        await writeToS3(tempRecordingFilename);
        await writeToS3(wavFileName);
        await deleteTempFile(path.join(LOCAL_TEMP_DIR,tempRecordingFilename));
        await deleteTempFile(path.join(LOCAL_TEMP_DIR, wavFileName));

        const url = new URL(RECORDING_FILE_PREFIX+wavFileName, `https://${RECORDINGS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com`);
        const recordingUrl = url.href;
        
        const callEvent: CallRecordingEvent = {
            EventType: 'ADD_S3_RECORDING_URL',
            CallId: callMetaData.callId,
            RecordingUrl: recordingUrl
        };
        await writeCallEvent(callEvent);
    })();

    if (audioInputStream) {
        audioInputStream.end();
        audioInputStream.destroy();
    }
};

const onWsClose = (ws:WebSocket, code: number): void => {
    ws.close(code);
    if (audioInputStream) {
        audioInputStream.end();
    }
};

// Start the websocket server on default port 3000 if no port supplied in environment variables
server.listen(
    { 
        port: parseInt(process.env?.['SERVERPORT'] ?? '8080'),
        host: process.env?.['SERVERHOST'] ?? '127.0.0.1'
    },
    (err) => {
        if (err) {
            server.log.error('Error starting websocket server: ',err);
            process.exit(1);
        }
        server.log.info(`Routes: \n${server.printRoutes()}`);
    }
);