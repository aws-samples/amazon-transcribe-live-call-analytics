import { 
    TranscribeStreamingClient,
    TranscribeStreamingClientConfig,
    TranscriptResultStream,
    StartCallAnalyticsStreamTranscriptionCommand,
    CallAnalyticsTranscriptResultStream,

    ConfigurationEvent,
    ParticipantRole,
    ChannelDefinition,
    StartStreamTranscriptionCommand,
    TranscriptEvent
} from '@aws-sdk/client-transcribe-streaming';

import * as chain from 'stream-chain';
import * as fs from 'fs';

import { 
    CallStartEvent,
    CallEndEvent, 
    Uuid
} from '../lca/entities-lca';

import { 
    writeCallEvent,
    writeAddTranscriptSegmentEvent,
    writeAddCallCategoryEvent,
    writeTranscriptionSegment
} from '../lca/lca';
import { randomUUID } from 'crypto';

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_SIZE_IN_MS = 200;
const LANGUAGE_CODE = 'en-US';

export class CallSimulator {
    readonly _client: TranscribeStreamingClient;
    readonly _mediafilename: string;
    readonly _apimode: string;
    readonly _callid: Uuid;

    constructor(mediaFileName: string, apiMode:string, region?: string) {
        const clientconfig: TranscribeStreamingClientConfig = {
            region: region
        };
        try {
            this._client = new TranscribeStreamingClient(clientconfig);
            console.info('Created Transcribe Streaming client');
        } catch (error) {
            console.error('Error creating Transcribe Streaming client', error);
            process.exit(1);
        }

        this._mediafilename = mediaFileName;
        this._apimode = apiMode;
        this._callid = randomUUID();
    }

    async startCall():Promise<void> {
        const now = new Date().toISOString();

        const callEvent: CallStartEvent = {
            EventType: 'START',
            CallId: this._callid,
            CustomerPhoneNumber: 'Customerphone',
            SystemPhoneNumber: 'Systemphone',
            CreatedAt: now,
        };
        await writeCallEvent(callEvent);
    }

    async endCall():Promise<void> {
        // const now = new Date().toISOString();
        const callEvent: CallEndEvent = {
            EventType: 'END',
            CallId: this._callid,
            CustomerPhoneNumber: 'Customerphone',
            SystemPhoneNumber: 'Systemphone',
            // UpdatedAt: now,
        };
        await writeCallEvent(callEvent);
    }

    async writeTranscriptEvents():Promise<void>{

        const CHUNK_SIZE = (SAMPLE_RATE * BYTES_PER_SAMPLE)*CHUNK_SIZE_IN_MS/1000;

        // const timer = (millisec: number) => new Promise(cb => setTimeout(cb, millisec));
        const audiopipeline:chain = new chain([
            fs.createReadStream(this._mediafilename, { highWaterMark: CHUNK_SIZE }),
            async data => {
                // await timer(CHUNK_SIZE_IN_MS);
                return data;
            }
        ]);

        // const audiopipeline = fs.createReadStream(this._mediafilename, { highWaterMark: 3200 }); 

        const transcribeInput = async function* (api: string) {
            if (api === 'analytics') {
                const channel0: ChannelDefinition = { ChannelId:0, ParticipantRole: ParticipantRole.CUSTOMER };
                const channel1: ChannelDefinition = { ChannelId:1, ParticipantRole: ParticipantRole.AGENT };
                const channel_definitions: ChannelDefinition [] = [];
                channel_definitions.push(channel0);
                channel_definitions.push(channel1);
                const configuration_event: ConfigurationEvent = { ChannelDefinitions: channel_definitions };
                yield { ConfigurationEvent: configuration_event };
            }
            for await (const chunk of audiopipeline) {
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        };

        let outputCallAnalyticsStream: AsyncIterable<CallAnalyticsTranscriptResultStream> | undefined;
        let outputTranscriptStream: AsyncIterable<TranscriptResultStream> | undefined;

        if (this._apimode === 'analytics') {
            const response = await this._client.send(
                new StartCallAnalyticsStreamTranscriptionCommand({
                    LanguageCode: LANGUAGE_CODE,
                    MediaSampleRateHertz: SAMPLE_RATE,
                    MediaEncoding: 'pcm',
                    AudioStream: transcribeInput(this._apimode)
                })
            );
            console.info(
                `=== Received Initial response from TCA. Session Id: ${response.SessionId} ===`
            );
            outputCallAnalyticsStream = response.CallAnalyticsTranscriptResultStream;
        } else {
            const response = await this._client.send(
                new StartStreamTranscriptionCommand({
                    LanguageCode: LANGUAGE_CODE,
                    MediaSampleRateHertz: SAMPLE_RATE,
                    MediaEncoding: 'pcm',
                    EnableChannelIdentification: true,
                    NumberOfChannels: 2,
                    AudioStream: transcribeInput(this._apimode)
                })
            );
            console.debug(
                `=== Received Initial response from Transcribe. Session Id: ${response.SessionId} ===`
            );
            outputTranscriptStream = response.TranscriptResultStream;
        }

        if (this._apimode === 'analytics') {
            if (outputCallAnalyticsStream) {   
                for await (const event of outputCallAnalyticsStream) {
                    if (event.UtteranceEvent && event.UtteranceEvent.UtteranceId) {
                        await writeAddTranscriptSegmentEvent(event.UtteranceEvent, undefined, this._callid);
                    }
                    if (event.CategoryEvent && event.CategoryEvent.MatchedCategories) {
                        await writeAddCallCategoryEvent(event.CategoryEvent, this._callid);
                    }
                }
            }

        } else {
            if (outputTranscriptStream) {   
                for await (const event of outputTranscriptStream) {
                    if (event.TranscriptEvent) {
                        const message: TranscriptEvent = event.TranscriptEvent;
                        await writeTranscriptionSegment(message, this._callid);
                    }
                }
            }
        }

    }
}