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

import { 
    TranscriptEvent, 
    UtteranceEvent,
    CategoryEvent,
} from '@aws-sdk/client-transcribe-streaming';

import { 
    KinesisClient, 
    PutRecordCommand 
} from '@aws-sdk/client-kinesis';

import { 
    CallStartEvent,
    CallEndEvent, 
    CallRecordingEvent,
    AddTranscriptSegmentEvent,
    AddCallCategoryEvent,
    Uuid
} from './entities-lca';

import dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';
const savePartial = (process.env['SAVE_PARTIAL_TRANSCRIPTS'] || 'true') === 'true';
const kdsStreamName = process.env['KINESIS_STREAM_NAME'] || '';

const kinesisClient = new KinesisClient({ region: awsRegion });

export const writeCallEvent = async (callEvent: CallStartEvent | CallEndEvent | CallRecordingEvent ) => {
    
    const putParams = {
        StreamName: kdsStreamName,
        PartitionKey: callEvent.CallId,
        Data: Buffer.from(JSON.stringify(callEvent))
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
        await kinesisClient.send(putCmd);
        console.debug('Written Call Event to KDS');
        console.debug(callEvent);
    } catch (error) {
        console.error('Error writing Call Event to KDS', error);
        console.debug(callEvent);
    }
};

// BabuS: TODO - writeTranscriptionSegment should be changed to support CustomCallTranscriptEvent 

export const writeTranscriptionSegment = async function(transcribeMessageJson:TranscriptEvent, callId: Uuid) {

    if (transcribeMessageJson.Transcript?.Results && transcribeMessageJson.Transcript?.Results.length > 0) {
        if (transcribeMessageJson.Transcript?.Results[0].Alternatives && transcribeMessageJson.Transcript?.Results[0].Alternatives?.length > 0) {
           
            const result = transcribeMessageJson.Transcript?.Results[0];

            if (result.IsPartial == undefined || (result.IsPartial == true && !savePartial)) {
                return;
            }
            const { Transcript: transcript } = transcribeMessageJson.Transcript.Results[0].Alternatives[0];
            const now = new Date().toISOString();

            const kdsObject:AddTranscriptSegmentEvent = {
                EventType: 'ADD_TRANSCRIPT_SEGMENT',
                CallId: callId,
                Channel: (result.ChannelId ==='ch_0' ? 'CALLER' : 'AGENT'),
                SegmentId: result.ResultId || '',
                StartTime: result.StartTime || 0,
                EndTime: result.EndTime || 0,
                Transcript: transcript || '',
                IsPartial: result.IsPartial,
                CreatedAt: now,
                TranscriptEvent: undefined,
                UtteranceEvent: undefined,
            };

            const putParams = {
                StreamName: kdsStreamName,
                PartitionKey: callId,
                Data: Buffer.from(JSON.stringify(kdsObject)),
            };

            const putCmd = new PutRecordCommand(putParams);
            try {
                await kinesisClient.send(putCmd);
                console.info('Written ADD_TRANSCRIPT_SEGMENT event to KDS');
                console.info(JSON.stringify(kdsObject));
            } catch (error) {
                console.error('Error writing transcription segment (TRANSCRIBE) to KDS', error);
                console.debug(JSON.stringify(kdsObject));
            }
        }
    }
};

export const writeAddTranscriptSegmentEvent = async function(utteranceEvent:UtteranceEvent | undefined , 
    transcriptEvent:TranscriptEvent | undefined,  callId: Uuid) {
    
    if (transcriptEvent) {
        if (transcriptEvent.Transcript?.Results && transcriptEvent.Transcript?.Results.length > 0) {
            if (transcriptEvent.Transcript?.Results[0].Alternatives && transcriptEvent.Transcript?.Results[0].Alternatives?.length > 0) {
            
                const result = transcriptEvent.Transcript?.Results[0];
                if (result.IsPartial == undefined || (result.IsPartial == true && !savePartial)) {
                    return;
                }
            }
        }
    }
                
    if (utteranceEvent) {
        if (utteranceEvent.IsPartial == undefined || (utteranceEvent.IsPartial == true && !savePartial)) {
            return;
        }
    }
   
    const now = new Date().toISOString();

    const kdsObject:AddTranscriptSegmentEvent = {
        EventType: 'ADD_TRANSCRIPT_SEGMENT',
        CallId: callId,
        TranscriptEvent: transcriptEvent,
        UtteranceEvent: utteranceEvent,
        CreatedAt: now,
    };

    const putParams = {
        StreamName: kdsStreamName,
        PartitionKey: callId,
        Data: Buffer.from(JSON.stringify(kdsObject)),
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
        await kinesisClient.send(putCmd);
        console.info('Written ADD_TRANSCRIPT_SEGMENT event to KDS');
        console.info(JSON.stringify(kdsObject));
    } catch (error) {
        console.error('Error writing transcription segment to KDS', error);
        console.debug(JSON.stringify(kdsObject));
    }
};

export const writeAddCallCategoryEvent = async function(categoryEvent:CategoryEvent, callId: Uuid) {

    if (categoryEvent) {
        const now = new Date().toISOString();
    
        const kdsObject:AddCallCategoryEvent = {
            EventType: 'ADD_CALL_CATEGORY',
            CallId: callId,
            CategoryEvent: categoryEvent,
            CreatedAt: now,
        };

        const putParams = {
            StreamName: kdsStreamName,
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