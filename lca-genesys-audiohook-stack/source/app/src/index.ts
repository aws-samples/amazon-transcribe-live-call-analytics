import fastify from 'fastify';
import websocket from 'fastify-websocket';
import { S3 } from 'aws-sdk';
import { pino } from 'pino';
import { RecordedSession, RecordingBucket } from './recordedsession';
import { isUuid } from './audiohook';
import { createMonoWavWriter, createWavWriter } from './wav-writer-demo';
import { initiateRequestAuthentication } from './authenticator';
import { queryCanonicalizedHeaderField } from './httpsignature';
import { addStreamToLCA } from './stream-to-lca';
import { writeRecordingUrlToKds } from './lca/lca';

import dotenv from 'dotenv';
dotenv.config();

const isDev = process.env['NODE_ENV'] !== 'production';

const server = fastify({
    logger: {
        prettyPrint: isDev ? {
            translateTime: 'SYS:HH:MM:ss.l',
            colorize: true,
            ignore: 'pid,hostname'
        } : false,
    },
});

server.register(websocket);

// Note: Treat empty string same as not present. We intentionally don't use nullish coalescing here!
const fileLogRoot = process.env['LOG_ROOT_DIR'] || process.cwd();
const recordingS3Bucket = process.env['RECORDINGS_BUCKET_NAME'] || null;
const recordingKeyPrefix = process.env['RECORDINGS_KEY_PREFIX'] || null;

server.log.info(`LocalLogRootDir: ${fileLogRoot}`);
server.log.info(`Recording S3 bucket: ${recordingS3Bucket ?? '<none>'}`);
server.log.info(`Recording S3 bucket Prefix: ${recordingKeyPrefix ?? '<none>'}`);

const recordingBucket: RecordingBucket | null = recordingS3Bucket ? {
    service: new S3(),
    name: recordingS3Bucket,
    keyprefix: recordingKeyPrefix ?? ''
} : null;

type ServiceState = 'INITIALIZING' | 'RUNNING' | 'DRAINING' | 'EXITING';
let serviceState: ServiceState = 'INITIALIZING';
let sessionCount = 0;

const drainAndExit = (reason: string) => {
    server.log.warn(`Initiating shutdown of process. Reason: ${reason}`);
    if (sessionCount > 0) {
        server.log.info(`Service has ${sessionCount} sessions, draining...`);

        // TODO: Send 'reconnect' on all active sessions.
        serviceState = 'DRAINING';
    } else {
        server.log.info('No session active, no need to drain.');
        setImmediate(() => {
            console.log('***** EXITING NOW!!! *****');
            process.exit(0);
        });
    }
};

process.once('SIGTERM', () => drainAndExit('SIGTERM'));
process.once('SIGINT', () => drainAndExit('SIGINT'));
process.once('SIGQUIT', () => drainAndExit('SIGQUIT'));
process.once('SIGSTP', () => drainAndExit('SIGSTP'));

const drainingCompleted = () => {
    serviceState = 'EXITING';
    server.log.warn('All sessions drained, initiating exit.');
    setImmediate(() => {
        console.log('***** EXITING NOW!!! *****');
        process.exit(0);
    });
};

server.get('/api/v1/audiohook/ws', { websocket: true }, (connection, request) => {

    request.log.info(`Websocket Request - URI: <${request.url}>, SocketRemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers, null, 1)}`);

    const sessionId = queryCanonicalizedHeaderField(request.headers, 'audiohook-session-id');
    if(!sessionId || !isUuid(sessionId)) {
        throw new RangeError('Missing or invalid "audiohook-session-id" header field');
    }
    if(isDev && (connection.socket.binaryType !== 'nodebuffer')) {
        throw new Error(`WebSocket binary type '${connection.socket.binaryType}' not supported`);
    }

    const logLevel = isDev ? 'debug' : 'info';

    // Slightly ugly hack because FastifyLoggerInstance.child() does not define 'options' (passing level in 'bindings' triggers PINODEP007)
    const logger = (server.log as ReturnType<typeof pino>).child({ session: sessionId }, { level: logLevel });
    
    // Create a session whose audio is recorded into a WAV file and protocol and log messages are written to a sidecar JSON file.
    // If an S3 bucket is configured, the two files are moved to the S3 bucket on completion.
    const recorder = RecordedSession.create({
        ws: connection.socket,
        sessionId,
        requestHeader: request.headers,
        requestUri: request.url,
        outerLogger: logger,
        outerLogLevel: logLevel,
        filePathRoot: fileLogRoot,
        recordingBucket
    });
    logger.info(`Session created. Logging sidecar file: ${recorder.sidecar.filepath}`);

    // Attach authenticator(s) to verify request signature
    initiateRequestAuthentication(recorder.session, request.raw);

    // Add agent assist handler (enabled through "customConfig" parameter in open message)
    // addAgentAssist(recorder.session);
    addStreamToLCA(recorder.session);


    if(isDev) {
        // Test WAV recording with channel extraction and transcoding to L16
        // Note: If a channel is not in accepted media, it's not recorded (no error).
        recorder.session.addOpenHandler(
            createMonoWavWriter(
                fileLogRoot, 
                (filename, samplesWritten) => {
                    logger.info(`Wrote ${samplesWritten} samples to ${filename}`);
                },
                'external', 
                'L16'
            ) 
        );

        recorder.session.addOpenHandler(
            createMonoWavWriter(
                fileLogRoot, 
                (filename, samplesWritten) => {
                    logger.info(`Wrote ${samplesWritten} samples to ${filename}`);
                },
                'internal', 
                'L16'
            ) 
        );
    }
    recorder.session.addOpenHandler(
        createWavWriter(
            fileLogRoot, 
            (filename, samplesWritten) => {
                (async () => {
                    await writeRecordingUrlToKds({
                        callId: recorder.session.id,
                        eventType: 'ADD_S3_RECORDING_URL',
                        recordingsBucket: recordingS3Bucket ?? '',
                        recordingsKeyPrefix: recordingKeyPrefix ?? '',
                        recordingsKey: filename
                    }); 
                })(); 
                logger.info(`Wrote ${samplesWritten} samples to ${filename}`);
            },
            'L16'
        )
    );


    ++sessionCount;
    recorder.session.addFiniHandler(() => {
        --sessionCount;
        if ((sessionCount === 0) && (serviceState === 'DRAINING')) {
            drainingCompleted();
        }
    });
});


type HealthCheckRemoteInfo = {
    addr: string;
    tsFirst: number;
    tsLast: number;
    count: number;
};
const healthCheckStats = new Map<string, HealthCheckRemoteInfo>();

server.get('/health/check', { logLevel: 'warn' }, (request, reply) => {
    const now = Date.now();
    const remoteIp = request.socket.remoteAddress;
    if (remoteIp) {
        const item = healthCheckStats.get(remoteIp);
        if (!item) {
            server.log.info(`First health check from new source. RemoteAddr: ${remoteIp}, URI: <${request.url}>, Headers: ${JSON.stringify(request.headers)}`);
            healthCheckStats.set(remoteIp, { addr: remoteIp, tsFirst: now, tsLast: now, count: 1 });
        } else {
            item.tsLast = now;
            ++item.count;
        }
    }

    const isHealthy = serviceState === 'RUNNING';
    const status = isHealthy ? 200 : 503;
    reply
        .code(status)
        .header('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate')
        .send({ 'Http-Status': status, 'Healthy': isHealthy });
});


server.listen(
    {
        port: parseInt(process.env?.['SERVERPORT'] ?? '3000'),
        host: process.env?.['SERVERHOST'] ?? '127.0.0.1'
    },
    (err) => {
        if (err) {
            console.error(err);
        }
        serviceState = 'RUNNING';
        server.log.info(`Routes: \n${server.printRoutes()}`);
    }
);

