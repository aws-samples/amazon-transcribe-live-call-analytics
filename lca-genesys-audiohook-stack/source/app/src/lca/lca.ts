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
    CallEventStatus, 
    CallRecordingEvent 
} from './entities-lca';

import { TranscriptEvent } from '@aws-sdk/client-transcribe-streaming';
import { 
    KinesisClient, 
    PutRecordCommand 
} from '@aws-sdk/client-kinesis';

import dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';
const expireInDays = 90;
const savePartial = process.env['SAVE_PARTIAL_TRANSCRIPTS'] === 'true';
const kdsStreamName = process.env['KINESIS_STREAM_NAME'] || '';

const kinesisClient = new KinesisClient({ region: awsRegion });

export const writeCallEventToKds = async (callEvent: CallEvent ) => {

    const now = new Date().toISOString();
    const expiration = Date.now() / 1000 + expireInDays * 24 * 3600;

    const kdsObj =  {
        CallId: callEvent.callId,
        EventType: callEvent.eventStatus,
        Channel: callEvent.channel,
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

export const writeStatusToKds = async (status: CallEventStatus) => {

    const now = new Date().toISOString();
    const expiration = Date.now() / 1000 + expireInDays * 24 * 3600;
  
    const kdsObj =  {
        CallId: status.callId,
        EventType: status.eventStatus,
        Channel: status.channel,
        TransactionId: status.transactionId || '', 
        CreatedAt: now,
        ExpiresAfter: expiration.toString(),
    };
    const putParams = {
        StreamName: kdsStreamName,
        PartitionKey: status.callId,
        Data: Buffer.from(JSON.stringify(kdsObj))
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
        await kinesisClient.send(putCmd);
    } catch (error) {
        console.error('Error writing transcription segment to KDS', error);
    }

};

export const writeTranscriptionSegment = async function(transcribeMessageJson:TranscriptEvent, callId: string, transactionId:string | undefined) {

    if (transcribeMessageJson.Transcript?.Results && transcribeMessageJson.Transcript?.Results.length > 0) {
        if (transcribeMessageJson.Transcript?.Results[0].Alternatives && transcribeMessageJson.Transcript?.Results[0].Alternatives?.length > 0) {
           
            const result = transcribeMessageJson.Transcript?.Results[0];

            if (result.IsPartial == undefined || (result.IsPartial == true && !savePartial)) {
                return;
            }
            
            const channel = (result.ChannelId ==='ch_0' ? 'CALLER' : 'AGENT');
            const startTime = result.StartTime || '';
            const endTime = result.EndTime || '';
            const resultId = result.ResultId || '';
            const transid = transactionId || '';
            const { Transcript: transcript } = transcribeMessageJson.Transcript.Results[0].Alternatives[0];
            const ispartial: boolean = result.IsPartial;
            // console.log(channel, ': ',transcript);
            const now = new Date().toISOString();
            const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;
            const eventType = 'ADD_TRANSCRIPT_SEGMENT';
            const kdsObject = {
                Channel: channel,
                TransactionId: transid,
                CallId: callId,
                SegmentId: resultId,
                StartTime: startTime.toString(),
                EndTime: endTime.toString(),
                Transcript: transcript || '',
                IsPartial: ispartial,
                EventType: eventType.toString(),
                CreatedAt: now,
                ExpiresAfter: expiration.toString(),
                StreamArn: '' 
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
                console.error('Error writing transcription segment to KDS', error);
            }
        }
    }
};