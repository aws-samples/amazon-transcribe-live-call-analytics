// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
    TranscribeStreamingClientConfig,
    StartCallAnalyticsStreamTranscriptionCommand,
    StartCallAnalyticsStreamTranscriptionCommandInput,
    CallAnalyticsTranscriptResultStream,
    ConfigurationEvent,
    ParticipantRole,
    ChannelDefinition,
    LanguageCode,
    StartStreamTranscriptionCommandInput,
    ContentRedactionOutput,
} from '@aws-sdk/client-transcribe-streaming';

import {
    DynamoDBClient,
    PutItemCommand
} from '@aws-sdk/client-dynamodb';

import { normalizeError } from './utils';
import dotenv from 'dotenv';
import { CallEndEvent, CallStartEvent } from './lca/entities-lca';
dotenv.config();

const formatPath = function (path: string) {
    let pathOut = path;
    if (path.length > 0 && path.charAt(path.length - 1) != '/') {
        pathOut += '/';
    }
    return pathOut;
};
const getExpiration = function getExpiration(numberOfDays: number) {
    return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const TRANSCRIBE_LANGUAGE_CODE = process.env['TRANSCRIBE_LANGUAGE_CODE'] || 'en-US';
const TRANSCRIBE_LANGUAGE_OPTIONS = process.env['TRANSCRIBE_LANGUAGE_OPTIONS'] || undefined;
const TRANSCRIBE_PREFERRED_LANGUAGE = process.env['TRANSCRIBE_PREFERRED_LANGUAGE'] || 'None';
const CUSTOM_VOCABULARY_NAME = process.env['CUSTOM_VOCABULARY_NAME'] || undefined;
const CUSTOM_LANGUAGE_MODEL_NAME = process.env['CUSTOM_LANGUAGE_MODEL_NAME'] || undefined;
const IS_CONTENT_REDACTION_ENABLED = (process.env['IS_CONTENT_REDACTION_ENABLED'] || '') === 'true';
const CONTENT_REDACTION_TYPE = process.env['CONTENT_REDACTION_TYPE'] || 'PII';
const TRANSCRIBE_PII_ENTITY_TYPES = process.env['TRANSCRIBE_PII_ENTITY_TYPES'] || undefined;
const TRANSCRIBE_API_MODE = process.env['TRANSCRIBE_API_MODE'] || 'standard';
const TCA_DATA_ACCESS_ROLE_ARN = process.env['TCA_DATA_ACCESS_ROLE_ARN'] || '';
const CALL_ANALYTICS_FILE_PREFIX = formatPath(process.env['CALL_ANALYTICS_FILE_PREFIX'] || 'lca-call-analytics-json/');
const RECORDINGS_BUCKET_NAME = process.env['RECORDINGS_BUCKET_NAME'] || null;
const TRANSCRIBER_CALL_EVENT_TABLE_NAME = process.env['TRANSCRIBER_CALL_EVENT_TABLE_NAME'];
// optional - provide custom Transcribe endpoint via env var
const TRANSCRIBE_ENDPOINT = process.env['TRANSCRIBE_ENDPOINT'] || '';
// optional - disable post call analytics output
const IS_TCA_POST_CALL_ANALYTICS_ENABLED = (process.env['IS_TCA_POST_CALL_ANALYTICS_ENABLED'] || 'true') === 'true';
// optional - when redaction is enabled, choose 'redacted' only (dafault), or 'redacted_and_unredacted' for both
const POST_CALL_CONTENT_REDACTION_OUTPUT = process.env['POST_CALL_CONTENT_REDACTION_OUTPUT'] || 'redacted';

const isTCAEnabled = TRANSCRIBE_API_MODE === 'analytics';
const tcaOutputLocation = `s3://${RECORDINGS_BUCKET_NAME}/${CALL_ANALYTICS_FILE_PREFIX}`;

type transcriptionCommandInput<TCAEnabled> = TCAEnabled extends true
    ? StartCallAnalyticsStreamTranscriptionCommandInput
    : StartStreamTranscriptionCommandInput;

type SessionData = {
    sessionId: string | undefined,
    callId: string,
    fromNumber: string,
    agentId?: string,
    callStreamingStartTime: string,
    tcaOutputLocation: string,
    tsParms: transcriptionCommandInput<typeof isTCAEnabled>
};

const dynamoClient = new DynamoDBClient({ region: AWS_REGION });

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
            SystemPhoneNumber: openparms.participant.dnis,
            CreatedAt: new Date().toISOString(),
        };

        await writeCallEvent(callEvent);

        const clientArgs: TranscribeStreamingClientConfig = {
            region: AWS_REGION
        };
        if (TRANSCRIBE_ENDPOINT) {
            session.logger.info(`Using custom Transcribe endpoint: ${TRANSCRIBE_ENDPOINT}`);
            clientArgs.endpoint = TRANSCRIBE_ENDPOINT;
        }
        session.logger.info(`Transcribe client args: ${JSON.stringify(clientArgs)}`);
        const client = new TranscribeStreamingClient(clientArgs);

        const audioDataIterator = pEvent.iterator<'audio', MediaDataFrame>(session, 'audio');

        const transcribeInput = async function* () {
            if (isTCAEnabled) {
                const channel0: ChannelDefinition = { ChannelId: 0, ParticipantRole: ParticipantRole.CUSTOMER };
                const channel1: ChannelDefinition = { ChannelId: 1, ParticipantRole: ParticipantRole.AGENT };
                const channel_definitions: ChannelDefinition[] = [];
                channel_definitions.push(channel0);
                channel_definitions.push(channel1);
                const configuration_event: ConfigurationEvent = { ChannelDefinitions: channel_definitions };
                if (IS_TCA_POST_CALL_ANALYTICS_ENABLED) {
                    configuration_event.PostCallAnalyticsSettings = {
                        OutputLocation: tcaOutputLocation,
                        DataAccessRoleArn: TCA_DATA_ACCESS_ROLE_ARN
                    };
                    if (IS_CONTENT_REDACTION_ENABLED) {
                        configuration_event.PostCallAnalyticsSettings.ContentRedactionOutput = POST_CALL_CONTENT_REDACTION_OUTPUT as ContentRedactionOutput;
                    }
                }
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

        const tsParams: transcriptionCommandInput<typeof isTCAEnabled> = {
            MediaSampleRateHertz: selectedMedia?.rate || 8000,
            MediaEncoding: 'pcm',
            AudioStream: transcribeInput()
        };

        if (TRANSCRIBE_LANGUAGE_CODE === 'identify-language') {
            tsParams.IdentifyLanguage = true;
            if (TRANSCRIBE_LANGUAGE_OPTIONS) {
                tsParams.LanguageOptions = TRANSCRIBE_LANGUAGE_OPTIONS.replace(/\s/g, '');
                if (TRANSCRIBE_PREFERRED_LANGUAGE !== 'None') {
                    tsParams.PreferredLanguage = TRANSCRIBE_PREFERRED_LANGUAGE as LanguageCode;
                }
            }
        } else if (TRANSCRIBE_LANGUAGE_CODE === 'identify-multiple-languages') {
            tsParams.IdentifyMultipleLanguages = true;
            if (TRANSCRIBE_LANGUAGE_OPTIONS) {
                tsParams.LanguageOptions = TRANSCRIBE_LANGUAGE_OPTIONS.replace(/\s/g, '');
                if (TRANSCRIBE_PREFERRED_LANGUAGE !== 'None') {
                    tsParams.PreferredLanguage = TRANSCRIBE_PREFERRED_LANGUAGE as LanguageCode;
                }
            }
        } else {
            tsParams.LanguageCode = TRANSCRIBE_LANGUAGE_CODE as LanguageCode;
        }

        if (IS_CONTENT_REDACTION_ENABLED && (
            TRANSCRIBE_LANGUAGE_CODE === 'en-US' ||
            TRANSCRIBE_LANGUAGE_CODE === 'en-AU' ||
            TRANSCRIBE_LANGUAGE_CODE === 'en-GB' ||
            TRANSCRIBE_LANGUAGE_CODE === 'es-US')) {
            tsParams.ContentRedactionType = CONTENT_REDACTION_TYPE as 'PII' | undefined;
            if (TRANSCRIBE_PII_ENTITY_TYPES) {
                tsParams.PiiEntityTypes = TRANSCRIBE_PII_ENTITY_TYPES;
            }
        }
        if (CUSTOM_VOCABULARY_NAME) {
            tsParams.VocabularyName = CUSTOM_VOCABULARY_NAME;
        }
        if (CUSTOM_LANGUAGE_MODEL_NAME) {
            tsParams.LanguageModelName = CUSTOM_LANGUAGE_MODEL_NAME;
        }

        let sessionId;
        if (isTCAEnabled) {
            const response = await client.send(
                new StartCallAnalyticsStreamTranscriptionCommand(tsParams as StartCallAnalyticsStreamTranscriptionCommandInput)
            );
            session.logger.info(
                `=== Received Initial response from TCA. Session Id: ${response.SessionId} ===`
            );
            sessionId = response.SessionId;
            outputCallAnalyticsStream = response.CallAnalyticsTranscriptResultStream;
        } else {
            (tsParams as StartStreamTranscriptionCommandInput).EnableChannelIdentification = true;
            (tsParams as StartStreamTranscriptionCommandInput).NumberOfChannels = selectedMedia?.channels.length || 2;
            const response = await client.send(
                new StartStreamTranscriptionCommand(tsParams)
            );
            session.logger.info(
                `=== Received Initial response from Transcribe. Session Id: ${response.SessionId} ===`
            );
            sessionId = response.SessionId;
            outputTranscriptStream = response.TranscriptResultStream;
        }

        const sessionData: SessionData = {
            sessionId: sessionId || undefined,
            callId: openparms.conversationId,
            fromNumber: openparms.participant.ani,
            agentId: undefined,
            callStreamingStartTime: new Date().toISOString(),
            tcaOutputLocation: tcaOutputLocation,
            tsParms: tsParams
        };
        await writeSessionDataToDdb(sessionData);

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
                .catch(err => {
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
                .catch(err => {
                    session.logger.error('Error processing transcribe results stream', normalizeError(err));
                    // console.log(err);
                });
        }

        return async () => {
            const callEvent: CallEndEvent = {
                EventType: 'END',
                CallId: openparms.conversationId,
                CustomerPhoneNumber: openparms.participant.ani,
                SystemPhoneNumber: openparms.participant.dnis,
            };

            await writeCallEvent(callEvent);

            session.logger.info('Close handler executed');
        };

    });
};

const writeSessionDataToDdb = async function writeSessionDataToDdb(sessionData: SessionData) {
    const expiration = getExpiration(1);
    const now = new Date().toISOString();
    const putParams = {
        TableName: TRANSCRIBER_CALL_EVENT_TABLE_NAME,
        Item: {
            PK: { S: `sd#${sessionData.sessionId}` },
            SK: { S: 'TRANSCRIBE SESSION' },
            CreatedAt: { S: now },
            ExpiresAfter: { N: expiration.toString() },
            SessionData: { S: JSON.stringify(sessionData) },
        },
    };
    const putCmd = new PutItemCommand(putParams);
    try {
        await dynamoClient.send(putCmd);
    } catch (error) {
        console.error('Error writing Session Data to Ddb', error);
    }
};