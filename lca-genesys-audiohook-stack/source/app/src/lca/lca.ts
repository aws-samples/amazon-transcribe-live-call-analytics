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
    CallEvent, 
    CallRecordingEvent,
    KDSTranscriptSegment,
    KDSMatchedCategories
} from './entities-lca';

import { 
    TranscriptEvent, 
    UtteranceEvent,
    CategoryEvent,
} from '@aws-sdk/client-transcribe-streaming';
import { 
    KinesisClient, 
    PutRecordCommand 
} from '@aws-sdk/client-kinesis';

import dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';
const expireInDays = 90;
const savePartial = (process.env['SAVE_PARTIAL_TRANSCRIPTS'] || 'true') === 'true';

const kdsStreamName = process.env['KINESIS_STREAM_NAME'] || '';

const kinesisClient = new KinesisClient({ region: awsRegion });

export const writeCallEventToKds = async (callEvent: CallEvent ) => {

    const now = new Date().toISOString();
    const expiration = Date.now() / 1000 + expireInDays * 24 * 3600;

    const kdsObj =  {
        CallId: callEvent.callId,
        EventType: callEvent.eventStatus,
        CustomerPhoneNumber: callEvent.fromNumber || '',
        SystemPhoneNumber: callEvent.toNumber || '',
        CreatedAt: now,
        ExpiresAfter: expiration.toString(),
    };
    
    const putParams = {
        StreamName: kdsStreamName,
        PartitionKey: callEvent.callId,
        Data: Buffer.from(JSON.stringify(kdsObj))
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
        await kinesisClient.send(putCmd);
    } catch (error) {
        console.error('Error writing transcription segment to KDS', error);
    }
};
export const writeRecordingUrlToKds = async (recordingEvent: CallRecordingEvent) => {

    const url = new URL(recordingEvent.recordingsKeyPrefix+recordingEvent.recordingsKey, `https://${recordingEvent.recordingsBucket}.s3.${awsRegion}.amazonaws.com`);
    const recordingUrl = url.href;
    
    const now = new Date();
    const currentTimeStamp = now.toISOString();
    const expiresAfter = Math.ceil((Number(now) + expireInDays * 24 * 3600 * 1000) / 1000,);
  
    const kdsObj =  {
        CallId: recordingEvent.callId,
        ExpiresAfter: expiresAfter.toString(),
        CreatedAt: currentTimeStamp,
        RecordingUrl: recordingUrl,
        EventType: recordingEvent.eventType,
    };

    const putParams = {
        StreamName: kdsStreamName,
        PartitionKey: recordingEvent.callId,
        Data: Buffer.from(JSON.stringify(kdsObj))
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
        await kinesisClient.send(putCmd);
    } catch (error) {
        console.error('Error writing transcription segment to KDS', error);
    }
};

export const writeTranscriptionSegment = async function(transcribeMessageJson:TranscriptEvent, callId: string) {

    if (transcribeMessageJson.Transcript?.Results && transcribeMessageJson.Transcript?.Results.length > 0) {
        if (transcribeMessageJson.Transcript?.Results[0].Alternatives && transcribeMessageJson.Transcript?.Results[0].Alternatives?.length > 0) {
           
            const result = transcribeMessageJson.Transcript?.Results[0];

            if (result.IsPartial == undefined || (result.IsPartial == true && !savePartial)) {
                return;
            }
            const { Transcript: transcript } = transcribeMessageJson.Transcript.Results[0].Alternatives[0];
            const now = new Date().toISOString();
            const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;

            const kdsObject:KDSTranscriptSegment = {
                EventType: 'ADD_TRANSCRIPT_SEGMENT',
                CallId: callId,
                Channel: (result.ChannelId ==='ch_0' ? 'CALLER' : 'AGENT'),
                SegmentId: result.ResultId || '',
                StartTime: result.StartTime || 0,
                EndTime: result.EndTime || 0,
                Transcript: transcript || '',
                IsPartial: result.IsPartial,
                CreatedAt: now,
                ExpiresAfter: expiration.toString(),
                Sentiment: undefined,
                IssuesDetected: undefined
            };

            const putParams = {
                StreamName: kdsStreamName,
                PartitionKey: callId,
                Data: Buffer.from(JSON.stringify(kdsObject)),
            };

            const putCmd = new PutRecordCommand(putParams);
            try {
                await kinesisClient.send(putCmd);
            } catch (error) {
                console.error('Error writing transcription segment (TRANSCRIBE) to KDS', error);
            }
        }
    }
};

export const writeTCASegment = async function(utterances:UtteranceEvent, callId: string) {
    
    if (utterances) {
    
        if (utterances.IsPartial == undefined || (utterances.IsPartial == true && !savePartial)) {
            return;
        }
        if (utterances.Transcript) {   
            const now = new Date().toISOString();
            const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;
            const kdsObject:KDSTranscriptSegment = {
                EventType: 'ADD_TRANSCRIPT_SEGMENT',
                CallId: callId,
                Channel: utterances.ParticipantRole || '',
                SegmentId: utterances.UtteranceId || '',
                StartTime: (utterances.BeginOffsetMillis || 0)/1000,
                EndTime: (utterances.EndOffsetMillis || 0)/1000,
                Transcript: utterances.Transcript,
                IsPartial: utterances.IsPartial,
                CreatedAt: now,
                ExpiresAfter: expiration.toString(),
                Sentiment: undefined,
                IssuesDetected: undefined
            };
            if (utterances.Sentiment) {
                kdsObject['Sentiment'] = utterances.Sentiment;
            }
            
            if (utterances.IssuesDetected) {
                kdsObject['IssuesDetected'] = utterances.IssuesDetected;
            }
            const putParams = {
                StreamName: kdsStreamName,
                PartitionKey: callId,
                Data: Buffer.from(JSON.stringify(kdsObject)),
            };

            const putCmd = new PutRecordCommand(putParams);
            try {
                await kinesisClient.send(putCmd);
                console.info('Written TCA ADD_TRANSCRIPT_SEGMENT event to KDS');
                console.info(JSON.stringify(kdsObject));
            } catch (error) {
                console.error('Error writing transcription segment (TCA) to KDS', error);
            }
        }
    }
};

export const writeCategoryMatched = async function(categories:CategoryEvent, callId: string) {

    if (categories) {
        categories.MatchedCategories?.forEach(async (category:string) => {
            for (const key in categories.MatchedDetails) {
                categories.MatchedDetails[key].TimestampRanges?.forEach(async (ts) => {
                    const now = new Date().toISOString();
                    const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;
                
                    const kdsObject:KDSMatchedCategories = {
                        EventType: 'ADD_CALL_CATEGORY',
                        CallId: callId,
                        MatchedCategory: category,
                        MatchedKeyWords: key,
                        StartTime: (ts.BeginOffsetMillis || 0)/1000,
                        EndTime: (ts.EndOffsetMillis || 0)/1000,
                        CreatedAt: now,
                        ExpiresAfter: expiration.toString(),
                    };

                    const putParams = {
                        StreamName: kdsStreamName,
                        PartitionKey: callId,
                        Data: Buffer.from(JSON.stringify(kdsObject)),
                    };
        
                    const putCmd = new PutRecordCommand(putParams);
                    try {
                        await kinesisClient.send(putCmd);
                        console.debug(JSON.stringify(kdsObject));
                    } catch (error) {
                        console.error('Error writing ADD_CALL_CATEGORY to KDS', error);
                    }

                });
            }
        });
    }
};