import { emitKeypressEvents } from 'readline';
import { Command } from 'commander';

import { WebSocket } from 'ws';
import * as fs from 'fs';
import Chain from 'stream-chain';

import { randomUUID } from 'crypto';

import {
    createWavFileReader,
} from '../../../lca-talkdesk-voicestream-stack/source/app/src/utils/wav';
import {
    ulawFromL16,
} from '../../../lca-talkdesk-voicestream-stack/source/app/src/utils/ulaw';

import {
    MediaStreamConnectedMessage,
    MediaStreamMediaMessage,
    MediaStreamStartMessage,
    MediaStreamStopMessage,
} from '../../../lca-talkdesk-voicestream-stack/source/app/src/mediastream';

import dotenv from 'dotenv';
dotenv.config();

const CHUNK_SIZE_IN_MS = parseInt(process.env['CHUNK_SIZE_IN_MS'] || '20', 10);
const STREAM_SID = process.env['STREAM_SID'] || randomUUID();
const ACCOUNT_SID = process.env['ACCOUNT_SID'] || randomUUID();
const CALL_SID = process.env['CALL_SID'] || randomUUID();
let SEQUENCE_NUMBER = 1;

type CmdOptions = {
    uri?: string;
    wavfile: string;
};
const timer = (millisec: number) => new Promise(cb => setTimeout(cb, millisec));


const talkdesk_client = async (serveruri: string | undefined, options: CmdOptions, command: Command): Promise<void> => {
 
    if (options.uri && serveruri) {
        command.error('More than one server URI specified!');
    }

    const uri = options.uri ?? serveruri;
    if (typeof (uri) === 'undefined') {
        command.error('Websocket server URI is required');
    }

    console.log(`Starting streaming session with ${uri}`);
    console.log(`Call ID : ${CALL_SID}`);
    
    const wss_url = new URL(uri);
    const ws = new WebSocket(wss_url);

    ws.on('open', async () => {

        console.log('Connected to server');

        console.log('Setting up wav file reader...');
        const wavreader = await createWavFileReader(options.wavfile, {
            allowedRates: [8000],
            channelMin: 2,
            channelMax: 2,
        });
    
        console.log(`Audio file name: ${options.wavfile}`);
        console.log(`Audio format: ${wavreader.format}`);
        console.log(`Number of channels: ${wavreader.channels}`);
        console.log(`Sampling rate: ${wavreader.rate} Hz`);
    
        let bytespersample = 2;
        if (wavreader.format === 'L16') {
            bytespersample = wavreader.channels * 2;
        } else if (wavreader.format === 'PCMU') {
            bytespersample = wavreader.channels * 1;
        }
        console.log(`Bytes per sample: ${bytespersample}`);
    
        const CHUNK_SIZE = wavreader.rate * (CHUNK_SIZE_IN_MS / 1000) * bytespersample;
        console.log(`Chunk Size = ${CHUNK_SIZE_IN_MS}ms ==> ${CHUNK_SIZE} samples ==> ${CHUNK_SIZE * bytespersample} bytes`);
        
        
        console.log('Sending Call Connected event');
        SEQUENCE_NUMBER = 1;
        const connectedMessage: MediaStreamConnectedMessage = {
            event: 'connected',
            protocol: 'Call',
            version: '1.0.0'
        };
        ws.send(JSON.stringify(connectedMessage));

        console.log('Sending Call Start event');
        SEQUENCE_NUMBER++;
        const startMessage: MediaStreamStartMessage = {
            event: 'start',
            sequenceNumber: SEQUENCE_NUMBER.toString(),
            start: {
                streamSid: STREAM_SID,
                accountSid: ACCOUNT_SID,
                callSid: CALL_SID,
                tracks: ['inbound', 'outbound'],
                mediaFormat: {
                    encoding: 'audio/x-mulaw',
                    sampleRate: wavreader.rate,
                    channels: 1
                }
            },
            streamSid: STREAM_SID
        };
        ws.send(JSON.stringify(startMessage));


        console.log('Sending Media events');
        let buf = await wavreader.readNext(CHUNK_SIZE);
        let payload: Uint8Array = new Uint8Array(buf!.length);

        let chunk = 1;
        let ts = 0;
        while (buf !== null) {
            if (wavreader.format === 'L16') {
                payload = ulawFromL16(buf as Int16Array);
            } else if (wavreader.format === 'PCMU') {
                payload = buf as Uint8Array;
            }

            let channel0: Uint8Array = new Uint8Array(payload.length / 2);
            let channel1: Uint8Array = new Uint8Array(payload.length / 2);
            let c = 0;
            for (let i = 0; i < payload.length; i += 2, ++c) {
                channel0[c] = payload[i];
                channel1[c] = payload[i + 1];
            }

            SEQUENCE_NUMBER++;
            const inbound_mediaMesage: MediaStreamMediaMessage = {
                event: 'media',
                sequenceNumber: SEQUENCE_NUMBER.toString(),
                media: {
                    track: 'inbound',
                    chunk: chunk.toString(),
                    timestamp: ts.toString(),
                    payload: Buffer.from(channel1).toString('base64'),
                },
                streamSid: STREAM_SID
            };
            ws.send(JSON.stringify(inbound_mediaMesage));
            await timer(CHUNK_SIZE_IN_MS);


            SEQUENCE_NUMBER++;
            const outbound_mediaMesage: MediaStreamMediaMessage = {
                event: 'media',
                sequenceNumber: SEQUENCE_NUMBER.toString(),
                media: {
                    track: 'outbound',
                    chunk: chunk.toString(),
                    timestamp: ts.toString(),
                    payload: Buffer.from(channel0).toString('base64'),
                },
                streamSid: STREAM_SID
            };
            ws.send(JSON.stringify(outbound_mediaMesage));
            await timer(CHUNK_SIZE_IN_MS);
            if (chunk % 1000 == 0) {
                console.log(`Inbound Media ${JSON.stringify(inbound_mediaMesage)}`);
                console.log(`Outbound Media ${JSON.stringify(outbound_mediaMesage)}`);
                console.log(`Payload Length : ${payload.length}`);
                console.log(`Payload Bytes: ${payload.byteLength}`);
            }
            buf = await wavreader.readNext(CHUNK_SIZE);
            chunk++;
            ts += CHUNK_SIZE_IN_MS;
        }

        wavreader.close();

        console.log('Sending Stop event');
        SEQUENCE_NUMBER++;
        const stopMessage: MediaStreamStopMessage = {
            event: 'stop',
            sequenceNumber: SEQUENCE_NUMBER.toString(),
            stop: {
                accountSid: ACCOUNT_SID,
                callSid: CALL_SID
            },
            streamSid: STREAM_SID
        };
        ws.send(JSON.stringify(stopMessage));
    });

    ws.on('message', (message: string) => {
        console.log(`Received message from server: ${message}`);
    });
    
    ws.on('close', () => {
        console.log('Disconnected from server');
    });
};

new Command()
    .description('LCA Websocket client')
    .showHelpAfterError()
    .argument('[serveruri]', 'URI of websocket server')
    .option('--uri <uri>', 'URI of websocket server')
    .option('--wavfile <wavfile>', 'WAV file to stream')
    .action(talkdesk_client)
    .parseAsync(process.argv);
    
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
    
let ctrlcHit = false;
process.stdin.on('keypress', (str, key) => {
    if(key.ctrl && (key.name === 'c' || key.name === 'd')) {
        if(!ctrlcHit) {
            closer();
            ctrlcHit = true;
        } else {
            console.log('Terminating now!');
            process.exit(1);    // If hit twice, exit immediately
        }
    } else {
        console.log(`You pressed the ${JSON.stringify(str)} key: ${JSON.stringify(key)}`);
    }
});
    
process.once('SIGTERM', () => {
    console.log('SIGTERM!');
    closer();
});

process.once('SIGINT', () => {
    console.log('SIGINT!');
    closer();
});


const closer = () => {
    console.log('Closing...');
    process.exit(1);
};