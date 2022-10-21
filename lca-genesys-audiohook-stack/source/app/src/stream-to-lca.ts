
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
import { writeCallEventToKds, writeStatusToKds, writeTranscriptionSegment } from './lca/lca';
import { 
    StartStreamTranscriptionCommand, 
    TranscribeStreamingClient, 
    TranscriptEvent
} from '@aws-sdk/client-transcribe-streaming';
import { normalizeError } from './utils';
import dotenv from 'dotenv';
dotenv.config();

const awsRegion = process.env['AWS_REGION'] || 'us-east-1';
const languageCode = process.env['TRANSCRIBE_LANGUAGE_CODE'] || 'en-US';
const customVocab = process.env['CUSTOM_VOCABULARY_NAME'] || undefined;
const customLanguageModel = process.env['CUSTOM_LANGUAGE_MODEL_NAME'] || undefined;
const isRedactionEnabled= process.env['IS_CONTENT_REDACTION_ENABLED'] || 'true';
const contentRedactionType = process.env['CONTENT_REDACTION_TYPE'] || undefined;
const piiEntities = process.env['TRANSCRIBE_PII_ENTITY_TYPES'] || undefined;

export const addStreamToLCA = (session: Session) => {

    session.addOpenHandler(async (session, selectedMedia, openparms) => {

        //##### LCA integration #####
        session.logger.info(`Conversation Id: ${openparms.conversationId}`);
        session.logger.info(`Channels supported: ${selectedMedia?.channels}`);
        session.logger.info('Call Participant: ');

        await writeCallEventToKds({
            callId: openparms.conversationId,
            eventStatus: 'START',
            channel: 'STEREO',
            fromNumber: openparms.participant.ani,
            toNumber: openparms.participant.dnis
        });
        
        const client = new TranscribeStreamingClient({
            region: awsRegion 
        });

        const audioDataIterator = pEvent.iterator<'audio', MediaDataFrame>(session, 'audio'); 
        
        const transcribeInput = async function* () {
            for await (const audiodata of audioDataIterator) {
                const data = audiodata.as('L16').audio.data;
                const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        };

        const {
            SessionId: sid,
            TranscriptResultStream: transcribeResultStream,
        } = await client.send(
            new StartStreamTranscriptionCommand({
                LanguageCode: languageCode,
                MediaSampleRateHertz: selectedMedia?.rate || 8000,
                MediaEncoding: 'pcm',
                EnableChannelIdentification: true,
                NumberOfChannels: selectedMedia?.channels.length || 2,
                VocabularyName: customVocab,
                LanguageModelName: customLanguageModel,
                ContentRedactionType: (isRedactionEnabled === 'true') ? contentRedactionType : undefined,
                PiiEntityTypes: (isRedactionEnabled === 'true') && (contentRedactionType === 'PII') ? piiEntities : undefined,
                AudioStream: transcribeInput()
            })
        );

        session.logger.info(
            `=== Received Initial response. Session Id: ${sid} ===`
        );
        await writeStatusToKds({
            callId: openparms.conversationId,
            eventStatus: 'START_TRANSCRIPT',
            channel: 'STEREO',
            transactionId: sid
        });
        
        (async () => {
            if (transcribeResultStream) {   
                for await (const event of transcribeResultStream) {
                    if (event.TranscriptEvent) {
                        const message: TranscriptEvent = event.TranscriptEvent;
                        await writeTranscriptionSegment(message, openparms.conversationId, sid);
                    }
                }
            }
        })()
            .then(() => {
                session.logger.info('##### Trans results stream ended');
            })
            .catch (err => {
                session.logger.error('Error processing transcribe results stream', normalizeError(err));
                console.log(err);
            });

        
        return async () => {
            
            await writeStatusToKds({
                callId: openparms.conversationId,
                eventStatus: 'END_TRANSCRIPT',
                channel: 'STEREO',
                transactionId: sid
            });      
            
            await writeCallEventToKds({
                callId: openparms.conversationId,
                eventStatus: 'END',
                channel: 'STEREO',
                fromNumber: openparms.participant.ani,
                toNumber: openparms.participant.dnis,
            });        
  
            session.logger.info('Close handler executed');
        };
    
    });
};