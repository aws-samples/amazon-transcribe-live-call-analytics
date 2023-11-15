// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws'; // type structure for the websocket object used by fastify/websocket
import stream from 'stream';
import os from 'os';
import path from 'path';
import { 
    S3Client, 
    PutObjectCommand
} from '@aws-sdk/client-s3';

import fs from 'fs';
import { randomUUID } from 'crypto';

import {  
    startTranscribe, 
    CallMetaData, 
    writeCallStartEvent,
    writeCallEndEvent,
} from './lca';
import { jwtVerifier } from './jwt-verifier';
// import { WavFileWriter } from './wav';

let callMetaData: CallMetaData;  // Type structure for call metadata sent by the client
let audioInputStream: stream.PassThrough; // audio chunks are written to this stream for Transcribe SDK to consume

let tempRecordingFilename: string;
let wavFileName: string;
let recordingFileSize: number = 0;
// let wavWriter: WavFileWriter;
let writeRecordingStream: fs.WriteStream;

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || undefined;
const CPU_HEALTH_THRESHOLD = parseInt(process.env['CPU_HEALTH_THRESHOLD'] || '50', 10);

const s3Client = new S3Client({ region: AWS_REGION });

const isDev = process.env['NODE_ENV'] !== 'PROD';

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

// Setup preHandler hook to authenticate 
server.addHook('preHandler', async (request, reply) => {
    // console.log(request);
    if (!request.url.includes('health/check')) { 
        await jwtVerifier(request, reply);
    }
});

// Setup Route for websocket connection
server.get('/api/v1/ws', { websocket: true, logLevel: 'info' }, (connection, request) => {
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

// Setup handlers for websocket events - 'message', 'close', 'error'
const registerHandlers = (ws: WebSocket): void => {
    ws.on('message', (data, isBinary): void => {
        try {
            if (isBinary) {
                const audioinput = Buffer.from(data as Uint8Array);
                onBinaryMessage(audioinput);
            } else {
                onTextMessage(Buffer.from(data as Uint8Array).toString('utf8'));
            }
        } catch (err) {
            server.log.error('Error processing message: ', err);
        }
    });

    ws.on('close', (code: number) => {
        try {
            onWsClose(ws, code);
            (async () => {
                await writeCallEndEvent(callMetaData);
                // const written = await wavWriter.close();
                // server.log.info(`${written} samples to wav file`);
                writeRecordingStream.end();

                const header = createHeader(recordingFileSize);
                const readStream = fs.createReadStream(path.join('/tmp/',tempRecordingFilename));
                const writeStream = fs.createWriteStream(path.join('/tmp/', wavFileName));
                writeStream.write(header);
                for await (const chunk of readStream) {
                    writeStream.write(chunk);
                }
                writeStream.end();

                await writeToS3(tempRecordingFilename);
                await writeToS3(wavFileName);
                await deleteTempFile(path.join('/tmp/',tempRecordingFilename));
                await deleteTempFile(path.join('/tmp/', wavFileName));
            })();
        } catch (err) {
            server.log.error('Error in WS close handler: ', err);
        }
    });

    ws.on('error', (error: Error) => {
        server.log.error('Websocket error, forcing close: ', error);
        ws.close();
    });
};

const onBinaryMessage = (data: Uint8Array): void => {
    // server.log.info(`Binary message. Size: ${data.length}`);
    if (audioInputStream) {
        audioInputStream.write(data);
        // wavWriter.writeAudio(data);
        writeRecordingStream.write(data);
        recordingFileSize += data.length;
    } else {
        server.log.error('Error: received audio data before metadata');
    }
};

const onTextMessage = (data: string): void => {
    // server.log.info(`Text message received. Size: ${data.length}`);
    try {
        callMetaData = JSON.parse(data);
        // server.log.info('Call Metadata received from client : ', callMetaData);
    } catch (error) {
        server.log.error('Error parsing call metadata: ', data);
        callMetaData.callId = randomUUID();
    }
    
    callMetaData.callId = callMetaData.callId || randomUUID();
    callMetaData.fromNumber = callMetaData.fromNumber || 'Customer Phone';
    callMetaData.toNumber = callMetaData.toNumber || 'System Phone';
    callMetaData.shouldRecordCall = callMetaData.shouldRecordCall || false;
    callMetaData.agentId = callMetaData.agentId || randomUUID();

    (async () => {
        await writeCallStartEvent(callMetaData);
        tempRecordingFilename = `${callMetaData.callId}.raw`;
        wavFileName = `${callMetaData.callId}.wav`
        // wavWriter = await WavFileWriter.create(path.join('/tmp/', tempRecordingFilename), 'L16', callMetaData.samplingRate || 48000, 2);
        writeRecordingStream = fs.createWriteStream(path.join('/tmp/', tempRecordingFilename));
        recordingFileSize = 0;
    })();
    audioInputStream = new stream.PassThrough();
    startTranscribe(callMetaData, audioInputStream);
};

const onWsClose = (ws:WebSocket, code: number): void => {
    server.log.info('Received close message from client: ',code);
    ws.close(code);
    if (audioInputStream) {
        audioInputStream.end();
    }
};

const writeToS3 = async (tempFileName:string) => {
    const sourceFile = path.join('/tmp/', tempFileName);

    console.log('Uploading audio to S3');
    let data;
    const fileStream = fs.createReadStream(sourceFile);
    const uploadParams = {
        Bucket: RECORDINGS_BUCKET_NAME,
        Key: 'lca-audio-wav/' + tempFileName,
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

const deleteTempFile = async(sourceFile:string) => {
    try {
        console.log('deleting tmp file');
        await fs.promises.unlink(sourceFile);
    } catch (err) {
        console.error('error deleting: ', err);
    }
};

const createHeader = function createHeader(length:number) {
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
    buffer.writeUInt16LE(2, 22);
    // sample rate
    buffer.writeUInt32LE(callMetaData.samplingRate, 24);
    // byte rate (sample rate * block align)
    buffer.writeUInt32LE(callMetaData.samplingRate * 2 * 2, 28);
    // block align (channel count * bytes per sample)
    buffer.writeUInt16LE(2 * 2, 32);
    // bits per sample
    buffer.writeUInt16LE(16, 34);
    // data chunk identifier 'data'
    buffer.writeUInt32BE(1684108385, 36);
    buffer.writeUInt32LE(length, 40);
  
    return buffer;
  };