
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

import pEvent from 'p-event';
import { MediaDataFrame } from './audiohook/mediadata';
import { Session } from './session';
import { 
    writeCallEvent, 
    writeTranscriptionSegment,
    writeAddTranscriptSegmentEvent,
    writeAddCallCategoryEvent,
} from './lca/lca';
import { 
    TranscribeStreamingClient, 
    StartStreamTranscriptionCommand, 
    TranscriptResultStream,
    TranscriptEvent,
    StartCallAnalyticsStreamTranscriptionCommand,
    CallAnalyticsTranscriptResultStream,
    ConfigurationEvent,
    ParticipantRole,
    ChannelDefinition
} from '@aws-sdk/client-transcribe-streaming';
import { normalizeError } from './utils';
import dotenv from 'dotenv';
import { CallEndEvent, CallStartEvent } from './lca/entities-lca';
dotenv.config();

const awsRegion = process.env['AWS_REGION'] || 'us-east-1';
const languageCode = process.env['TRANSCRIBE_LANGUAGE_CODE'] || 'en-US';
const customVocab = process.env['CUSTOM_VOCABULARY_NAME'] || undefined;
const isRedactionEnabled= process.env['IS_CONTENT_REDACTION_ENABLED'] || 'true';
const contentRedactionType = process.env['CONTENT_REDACTION_TYPE'] || undefined;
const piiEntities = process.env['TRANSCRIBE_PII_ENTITY_TYPES'] || undefined;
const isTCAEnabled = true;

export const addStreamToLCA = (session: Session) => {

    session.addOpenHandler(async (session, selectedMedia, openparms) => {

        //##### LCA integration #####
        session.logger.info(`Conversation Id: ${openparms.conversationId}`);
        session.logger.info(`Channels supported: ${selectedMedia?.channels}`);
        session.logger.info('Call Participant: ');

        const callEvent: CallStartEvent = {
            EventType: 'START',
            CallId: openparms.conversationId,
            CustomerPhoneNumber: openparms.participant.ani,
            SystemPhoneNumber: openparms.participant.dnis
        };

        await writeCallEvent(callEvent);
        
        const client = new TranscribeStreamingClient({
            region: awsRegion 
        });

        const audioDataIterator = pEvent.iterator<'audio', MediaDataFrame>(session, 'audio'); 
        
        const transcribeInput = async function* () {
            if (isTCAEnabled) {
                const channel0: ChannelDefinition = { ChannelId:0, ParticipantRole: ParticipantRole.CUSTOMER };
                const channel1: ChannelDefinition = { ChannelId:1, ParticipantRole: ParticipantRole.AGENT };
                const channel_definitions: ChannelDefinition [] = [];
                channel_definitions.push(channel0);
                channel_definitions.push(channel1);
                const configuration_event: ConfigurationEvent = { ChannelDefinitions: channel_definitions };
                yield { ConfigurationEvent: configuration_event };
            }
            for await (const audiodata of audioDataIterator) {
                const data = audiodata.as('L16').audio.data;
                const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        };

 
        let outputCallAnalyticsStream: AsyncIterable<CallAnalyticsTranscriptResultStream> | undefined;
        let outputTranscriptStream: AsyncIterable<TranscriptResultStream> | undefined;

        if (isTCAEnabled) {
            const response = await client.send(
                new StartCallAnalyticsStreamTranscriptionCommand({
                    LanguageCode: languageCode,
                    MediaSampleRateHertz: selectedMedia?.rate || 8000,
                    MediaEncoding: 'pcm',
                    // VocabularyName: customVocab,
                    // ContentRedactionType: (isRedactionEnabled === 'true') ? contentRedactionType : undefined,
                    // PiiEntityTypes: (isRedactionEnabled === 'true') && (contentRedactionType === 'PII') ? piiEntities : undefined,
                    AudioStream: transcribeInput()
                })
            );
            session.logger.info(
                `=== Received Initial response from TCA. Session Id: ${response.SessionId} ===`
            );
            outputCallAnalyticsStream = response.CallAnalyticsTranscriptResultStream;
        } else {
            const response = await client.send(
                new StartStreamTranscriptionCommand({
                    LanguageCode: languageCode,
                    MediaSampleRateHertz: selectedMedia?.rate || 8000,
                    MediaEncoding: 'pcm',
                    EnableChannelIdentification: true,
                    NumberOfChannels: selectedMedia?.channels.length || 2,
                    VocabularyName: customVocab,
                    ContentRedactionType: (isRedactionEnabled === 'true') ? contentRedactionType : undefined,
                    PiiEntityTypes: (isRedactionEnabled === 'true') && (contentRedactionType === 'PII') ? piiEntities : undefined,
                    AudioStream: transcribeInput()
                })
            );
            session.logger.info(
                `=== Received Initial response from Transcribe. Session Id: ${response.SessionId} ===`
            );
            outputTranscriptStream = response.TranscriptResultStream;
        }

        if (isTCAEnabled) {
            (async () => {
                if (outputCallAnalyticsStream) {   
                    for await (const event of outputCallAnalyticsStream) {
                        if (event.UtteranceEvent && event.UtteranceEvent.UtteranceId) {
                            await writeAddTranscriptSegmentEvent(event.UtteranceEvent, undefined, openparms.conversationId);
                        }
                        if (event.CategoryEvent && event.CategoryEvent.MatchedCategories) {
                            await writeAddCallCategoryEvent(event.CategoryEvent, openparms.conversationId);
                        }
                    }
                }
            })()
                .then(() => {
                    session.logger.info('##### Trans results stream ended');
                })
                .catch (err => {
                    session.logger.error('Error processing TCA results stream', normalizeError(err));
                    session.logger.error(err);
                    // console.log(err);
                });
        } else {
            (async () => {
                if (outputTranscriptStream) {   
                    for await (const event of outputTranscriptStream) {
                        if (event.TranscriptEvent) {
                            const message: TranscriptEvent = event.TranscriptEvent;
                            await writeTranscriptionSegment(message, openparms.conversationId);
                        }
                    }
                }
            })()
                .then(() => {
                    session.logger.info('##### Trans results stream ended');
                })
                .catch (err => {
                    session.logger.error('Error processing transcribe results stream', normalizeError(err));
                    // console.log(err);
                });
        }
        
        return async () => {
            const callEvent: CallEndEvent = {
                EventType: 'END',
                CallId: openparms.conversationId,
                CustomerPhoneNumber: openparms.participant.ani,
                SystemPhoneNumber: openparms.participant.dnis
            };
            
            await writeCallEvent(callEvent);
  
            session.logger.info('Close handler executed');
        };
    
    });
};