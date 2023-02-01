// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

import * as dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';
const savePartial = (process.env['SAVE_PARTIAL_TRANSCRIPTS'] || 'true') === 'true';
const kdsStreamName = process.env['KINESIS_STREAM_NAME'] || '';

const kinesisClient = new KinesisClient({ region: awsRegion });

export const writeCallEvent = async (callEvent: CallStartEvent | CallEndEvent | CallRecordingEvent ):Promise<void> => {
    
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

export const writeTranscriptionSegment = async function(transcribeMessageJson:TranscriptEvent, callId: Uuid):Promise<void> {

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
                UpdatedAt: now,
                Sentiment: undefined,
                TranscriptEvent: undefined,
                UtteranceEvent: undefined
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
    transcriptEvent:TranscriptEvent | undefined,  callId: Uuid):Promise<void> {
    
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
        UpdatedAt: now,
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

export const writeAddCallCategoryEvent = async function(categoryEvent:CategoryEvent, callId: Uuid):Promise<void> {

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