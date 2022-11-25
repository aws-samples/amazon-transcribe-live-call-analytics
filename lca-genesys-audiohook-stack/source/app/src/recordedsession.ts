// # Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// #
// # Licensed under the Apache License, Version 2.0 (the "License").
// # You may not use this file except in compliance with the License.
// # You may obtain a copy of the License at
// #
// # http://www.apache.org/licenses/LICENSE-2.0
// #
// # Unless required by applicable law or agreed to in writing, software
// # distributed under the License is distributed on an "AS IS" BASIS,
// # WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// # See the License for the specific language governing permissions and
// # limitations under the License.

import { FastifyLoggerInstance, LogLevel } from 'fastify';
import { IncomingHttpHeaders } from 'http';
import { WriteStream, createWriteStream, createReadStream } from 'fs';
import { unlink, stat } from 'fs/promises';
import { S3 } from 'aws-sdk';
import { Session, StatisticsInfo } from './session';
import { createSession, SessionWebSocket } from './sessionimpl';
import { writeCallEvent } from './lca/lca';
import { CallRecordingEvent } from './lca/entities-lca';

import { 
    StreamDuration, 
    ServerMessage, 
    ClientMessage, 
    JsonObject, 
    Duration,
    Uuid
} from './audiohook';
import { normalizeError, uuid } from './utils';
import { Logger } from './types';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';

export type RecordingBucket = {
    readonly service: S3;
    readonly name: string;
    readonly keyprefix: string;
};

type MoveFileToBucketResult = {
    uri: string;
    size: number;
};

const moveFileToBucket = async (srcpath: string, bucket: RecordingBucket, key: string): Promise<MoveFileToBucketResult> => {

    const { size } = await stat(srcpath);

    const request: S3.Types.PutObjectRequest = {
        Bucket: bucket.name,
        Key: bucket.keyprefix+key,
        Body: createReadStream(srcpath)
    };
    await bucket.service.putObject(request).promise();

    // Successfully copied to S3, delete the source file.
    await unlink(srcpath);

    return { uri: `s3://${bucket.name}/${key}`, size };
};


const logLevelMap: {
    [key in LogLevel]: number;
} = {
    'fatal': 60,
    'error': 50,
    'warn':  40,
    'info':  30,
    'debug': 20,
    'trace': 10,
} as const;

const logLevelNames = Object.entries(logLevelMap).sort(([,a], [, b]) => (a - b)).map(([k]) => k as LogLevel);

const lookupLogLevelName = (level: number): LogLevel => (
    logLevelNames[Math.floor((level - 5) / 10)]
);


class SidecarFileWriter {
    readonly id = uuid();
    readonly startTime = new Date();
    readonly startTimestamp = process.hrtime.bigint();
    readonly filepath: string;
    readonly logger: Logger;
    readonly outerLogger: FastifyLoggerInstance;

    fileWriter: WriteStream | null;
    rowcnt = 0;

    minLogLevelSidecar = 20;
    minLogLevelOuter: number;

    constructor(pathBase: string, outerLogger: FastifyLoggerInstance, outerLogLevel: LogLevel) {
        this.outerLogger = outerLogger;
        this.minLogLevelOuter = logLevelMap[outerLogLevel];
        this.filepath = path.join(pathBase, `${this.id}.json`);
        this.fileWriter = createWriteStream(this.filepath, { encoding: 'utf-8' });
        const header = {
            timestamp: this.startTime.toISOString(),
            id: this.id
        };
        this.fileWriter.write(`{\n "header":${JSON.stringify(header)},\n "body":[`);

        this.logger = {
            fatal: (msg: string, error?: Error): void => this.writeLogEntry(60, msg, error),
            error: (msg: string, error?: Error): void => this.writeLogEntry(50, msg, error),
            warn: (msg: string, error?: Error): void => this.writeLogEntry(40, msg, error),
            info: (msg: string, error?: Error): void => this.writeLogEntry(30, msg, error),
            debug: (msg: string, error?: Error): void => this.writeLogEntry(20, msg, error),
            trace: (msg: string, error?: Error): void => this.writeLogEntry(10, msg, error),
        };
    }

    async close(): Promise<void> {
        if(this.fileWriter) {
            this.renderEntry('end', {});
            const fileWriter = this.fileWriter;
            this.fileWriter = null;
            fileWriter.end('\n ]\n}\n');
            return new Promise((resolve, reject) => {
                fileWriter.on('finish', resolve);
                fileWriter.on('error', reject);
            });
        } else {
            throw new Error('Writer already closed');
        }
    }

    getTimestamp(): Duration {
        return StreamDuration.fromNanoseconds(process.hrtime.bigint() - this.startTimestamp).asDuration();
    }

    writeLogEntry(level: number, msg: string, error?: Error): void {
        if (level >= this.minLogLevelOuter) {
            this.outerLogger[lookupLogLevelName(level)](msg, error);
        }
        if (error) {
            this.renderEntry('logger', { level, msg: `${msg}${error ? (error.message || error.stack) : ''}` });
        } else if(level >= this.minLogLevelSidecar) {
            this.renderEntry('logger', { level, msg });
        }
    }

    writeReceivedMessage(message: JsonObject): void {
        this.renderEntry('audiohook', { dir: 'in', message });
    }

    writeSentMessage(message: JsonObject): void {
        this.renderEntry('audiohook', { dir: 'out', message });
    }

    writeStatisticsUpdate(info: StatisticsInfo): void {
        this.renderEntry('statistics', { 
            rtt: info.rtt.asDuration()
        });
    }

    writeHttpRequestInfo(headers: IncomingHttpHeaders, uri: string) {
        this.renderEntry('httpInfo', { uri, headers: headers as JsonObject });
    }

    renderEntry(type: string, data: JsonObject): boolean {
        const timestamp = this.getTimestamp();
        return this.fileWriter?.write(`${this.rowcnt++ === 0 ? '' : ','}\n  ${JSON.stringify({ timestamp, type, data })}`) ?? true;
    }
}

const activeSessions = new Map<string, RecordedSession>();


export type RecordedSessionConfig = {
    readonly ws: SessionWebSocket;
    readonly sessionId: Uuid;
    readonly requestHeader: IncomingHttpHeaders;
    readonly requestUri: string;
    readonly outerLogger: FastifyLoggerInstance;
    readonly outerLogLevel: LogLevel;
    readonly filePathRoot: string;
    readonly recordingBucket: RecordingBucket | null;
};

export class RecordedSession {
    readonly recordingId: string;
    readonly session: Session;
    readonly sidecar: SidecarFileWriter;
    readonly recordingBucket: RecordingBucket | null;
    filePathWav: string | null = null;

    private unregister: (() => void) | null;

    private constructor(session: Session, sidecar: SidecarFileWriter, config: RecordedSessionConfig) {
        this.recordingId = sidecar.id;
        this.session = session;
        this.sidecar = sidecar;
        this.recordingBucket = config.recordingBucket;

        this.session.addFiniHandler(async () => this.onSessionFini());
        activeSessions.set(this.recordingId, this);

        this.unregister = (() => {
            const handleStatistics = (info: StatisticsInfo) => this.onStatisticsUpdate(info);
            const handleClientMessage = (message: ClientMessage) => this.onClientMessage(message);
            const handleServerMessage = (message: ServerMessage) => this.onServerMessage(message);
            this.session.on('statistics', handleStatistics);
            this.session.on('clientMessage', handleClientMessage);
            this.session.on('serverMessage', handleServerMessage);
            return () => {
                this.session.off('statistics', handleStatistics);
                this.session.off('clientMessage', handleClientMessage);
                this.session.off('serverMessage', handleServerMessage);
            };
        })();
    }

    static create(config: RecordedSessionConfig): RecordedSession {
        const sidecar = new SidecarFileWriter(config.filePathRoot, config.outerLogger, config.outerLogLevel);
        sidecar.writeHttpRequestInfo(config.requestHeader, config.requestUri);
        const session = createSession(config.ws, config.sessionId, sidecar.logger);
        return new RecordedSession(session, sidecar, config);
    }

    onClientMessage(message: ClientMessage): void {
        this.sidecar.writeReceivedMessage(message);
    }

    onServerMessage(message: ServerMessage): void {
        this.sidecar.writeSentMessage(message);
    }

    onStatisticsUpdate(info: StatisticsInfo): void {
        this.sidecar.writeStatisticsUpdate(info);
    }

    async onSessionFini(): Promise<void> {
        this.unregister?.();
        this.unregister = null;
        const outerLogger = this.sidecar.outerLogger;
        await this.sidecar.close();

        outerLogger.info(`Finalized and closed sidecar file: ${this.sidecar.filepath}`);

        let s3UriWav: string | null = null;
        let s3UriSidecar: string | null = null;
        if(this.recordingBucket) {
            const iso8601 = this.sidecar.startTime.toISOString();
            const keybase = `${iso8601.substring(0, 10)}/${this.sidecar.id}`;

            if(this.filePathWav) {
                const key = path.basename(this.filePathWav);
                try {
                    const { uri, size } = await moveFileToBucket(this.filePathWav, this.recordingBucket, key);
                    s3UriWav = uri;
                    outerLogger.info(`Moved ${this.filePathWav} to ${s3UriWav}. Size: ${size}`);
                    
                } catch(err) {
                    outerLogger.warn(`Error copying "${this.filePathWav}" to bucket=${this.recordingBucket.name}, key=${key}: ${normalizeError(err).message}`);
                }
                const callid = path.parse(this.filePathWav).name;
                const url = new URL(this.recordingBucket.keyprefix+key, `https://${this.recordingBucket.name}.s3.${awsRegion}.amazonaws.com`);
                const recordingUrl = url.href;
                
                const callEvent: CallRecordingEvent = {
                    EventType: 'ADD_S3_RECORDING_URL',
                    CallId: callid,
                    RecordingUrl: recordingUrl
                };
                await writeCallEvent(callEvent);
                outerLogger.info('Written Add s3 recording event to KDS');
                outerLogger.debug(JSON.stringify(callEvent));
            }

            try {
                const { uri, size } = await moveFileToBucket(this.sidecar.filepath, this.recordingBucket, `${keybase}.json`);
                s3UriSidecar = uri;
                outerLogger.info(`Moved ${this.sidecar.filepath} to ${s3UriSidecar}. Size: ${size}`);
            } catch(err) {
                outerLogger.warn(`Error copying "${this.sidecar.filepath}" to bucket=${this.recordingBucket.name}, key=${keybase}.json: ${normalizeError(err).message}`);
            }

        } else {
            outerLogger.warn(`No S3 bucket configured, files not uploaded. Sidecar: ${this.sidecar.filepath}, WAV: ${this.filePathWav ? this.filePathWav : '<none>'}`);
        }
        
        // All data moved to S3. Session complete for good.

        activeSessions.delete(this.recordingId);
    }
}
