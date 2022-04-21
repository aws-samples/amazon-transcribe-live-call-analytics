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

import { CallEvent, CallEventStatus, CallRecordingEvent } from './entities-lca';
import {
    DynamoDBClient,
    PutItemCommand
} from '@aws-sdk/client-dynamodb';
import { TranscriptEvent } from '@aws-sdk/client-transcribe-streaming';
import dotenv from 'dotenv';
dotenv.config();

const awsRegion:string = process.env['AWS_REGION'] || 'us-east-1';
const ddbTableName = process.env['EVENT_SOURCING_TABLE_NAME'] || null;
const expireInDays = Number(process.env['EXPIRATION_IN_DAYS']) || 90;
const savePartial = process.env['SAVE_PARTIAL_TRANSCRIPTS'] === 'true';

const dynamoClient = new DynamoDBClient({ region: awsRegion });
export const writeCallEventToDynamo = async (callEvent: CallEvent ) => {

    const now = new Date().toISOString();
    const expiration = Date.now() / 1000 + expireInDays * 24 * 3600;

    const putParams = {
        TableName: ddbTableName ?? '',
        Item: {
            PK: { 'S' : `ce#${callEvent.callId}` },
            SK: { 'S' : `ts#${now}#et#${callEvent.eventStatus}#c#${callEvent.channel}` },
            CallId: { 'S' : callEvent.callId },
            EventType: { 'S' : callEvent.eventStatus },
            Channel: { 'S' : callEvent.channel },
            CustomerPhoneNumber: { 'S' : callEvent.fromNumber || '' },
            SystemPhoneNumber: { 'S' : callEvent.toNumber || '' },
            CreatedAt: { 'S' : now },
            ExpiresAfter: { 'N' : expiration.toString() },
        }
    };

    const putCmd = new PutItemCommand(putParams);
    try {
        await dynamoClient.send(putCmd);
    } catch (err) {
        console.error(err);
    }
};

export const writeRecordingUrlToDynamo = async (recordingEvent: CallRecordingEvent) => {

    const url = new URL(recordingEvent.recordingsKeyPrefix+recordingEvent.recordingsKey, `https://${recordingEvent.recordingsBucket}.s3.${awsRegion}.amazonaws.com`);
    const recordingUrl = url.href;
    
    const now = new Date();
    const currentTimeStamp = now.toISOString();
    const expiresAfter = Math.ceil((Number(now) + expireInDays * 24 * 3600 * 1000) / 1000,);
  
    const putParams = {
        TableName: ddbTableName ?? '',
        Item : {
            PK: { 'S' : `ce#${recordingEvent.callId}` },  
            SK: { 'S' : `ts#${currentTimeStamp}#et#${recordingEvent.eventType}` },
            CallId: { 'S' : recordingEvent.callId },
            ExpiresAfter: { 'N' : expiresAfter.toString() },
            CreatedAt: { 'S' : currentTimeStamp },
            RecordingUrl: { 'S' : recordingUrl },
            EventType: { 'S' : recordingEvent.eventType },
        }
    };
    
    const putCmd = new PutItemCommand(putParams);
  
    try {
        await dynamoClient.send(putCmd);
    } catch (error) {
        console.error(error);  
    }
};

export const writeStatusToDynamo = async (status: CallEventStatus) => {

    const now = new Date().toISOString();
    const expiration = Date.now() / 1000 + expireInDays * 24 * 3600;
  
    const putParams = {
        TableName: ddbTableName ?? '',
        Item: {
            PK: { 'S' : `ce#${status.callId}` },
            SK: { 'S' : `ts#${now}#et${status.eventStatus}#c#${status.channel}` },
            CallId: { 'S' : status.callId },
            EventType: { 'S' : status.eventStatus },
            Channel: { 'S' : status.channel },
            TransactionId: { 'S': status.transactionId || '' }, 
            CreatedAt: { 'S' : now },
            ExpiresAfter: { 'N' : expiration.toString() },
        }
    };

    const putCmd = new PutItemCommand(putParams);
    try {
        await dynamoClient.send(putCmd);
    } catch (err) {
        console.error(err);
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
            const putParams = {
                TableName: ddbTableName ?? '',
                Item : {
                    PK: { 'S' : `ce#${callId}` },
                    SK: { 'S' : `ts#${now}#et#${eventType}#c#${channel}` },
                    Channel: { 'S' : channel },
                    TransactionId: { 'S': transid },
                    CallId: { 'S': callId },
                    SegmentId: { 'S': resultId },
                    StartTime: { 'N': startTime.toString() },
                    EndTime: { 'N': endTime.toString() },
                    Transcript: { 'S': transcript || '' },
                    IsPartial: { 'BOOL': ispartial },
                    EventType: { 'S': eventType.toString() },
                    CreatedAt: { 'S': now },
                    ExpiresAfter: { 'N': expiration.toString() }
                }
            };
            
            const putCmd = new PutItemCommand(putParams);
            try {
                await dynamoClient.send(putCmd);
            } catch (error) {
                console.error(error);
            }
        }
    }
};