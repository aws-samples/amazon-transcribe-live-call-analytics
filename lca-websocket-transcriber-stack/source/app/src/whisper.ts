// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/brace-style */

import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';
import { v4 as uuidv4 } from 'uuid';
import { TranscriptEvent, StartStreamTranscriptionCommandInput, StartCallAnalyticsStreamTranscriptionCommandInput, UtteranceEvent, CategoryEvent } from '@aws-sdk/client-transcribe-streaming';
import { FastifyInstance } from 'fastify';
// import { createWavHeader } from './utils';
import { PassThrough } from 'stream';
import fs from 'fs';
import { WriteStream } from 'fs';
import { AudioStream } from '@aws-sdk/client-transcribe-streaming';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Define a type for VAD to avoid using @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VAD = require('node-vad');

const s3Client = new S3Client({});

class EventResult {
    TranscriptEvent?: TranscriptEvent;
    UtteranceEvent?: UtteranceEvent;
    CategoryEvent?: CategoryEvent;

    constructor(TranscriptEvent?: TranscriptEvent, UtteranceEvent?: UtteranceEvent, CategoryEvent?: CategoryEvent) {
        this.TranscriptEvent = TranscriptEvent;
        this.UtteranceEvent = UtteranceEvent;
        this.CategoryEvent = CategoryEvent;
    }
}

class VadResults {
    remainingSamples: number[];
    silenceFrameCount: number;
    TranscriptEvents: EventResult[];

    constructor(remainingSamples: number[], silenceFrameCount: number, TranscriptEvents: EventResult[]) {
        this.remainingSamples = remainingSamples;
        this.silenceFrameCount = silenceFrameCount;
        this.TranscriptEvents = TranscriptEvents;
    }
}

// Define VAD types
interface VadInstance {
    processAudio(buffer: Buffer, sampleRate: number): Promise<number>;
}

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const WHISPER_SAGEMAKER_ENDPOINT = process.env['WHISPER_SAGEMAKER_ENDPOINT'] || '';
const NO_SPEECH_THRESHOLD = parseFloat(process.env['NO_SPEECH_THRESHOLD'] || '0.2');
const TRANSCRIPTION_INTERVAL = parseInt(process.env['TRANSCRIPTION_INTERVAL'] || '1000'); // 1 second in milliseconds
const SAMPLE_RATE = 16000; // 16kHz audio
const DEBUG_WRITE_TO_S3 = process.env['DEBUG_WRITE_TO_S3'] === 'true' || true;
const OUTPUT_BUCKET = process.env['RECORDINGS_BUCKET_NAME'] || '';

// Initialize VAD instances for each channel
const leftVad = new VAD(VAD.Mode.AGGRESSIVE);
const rightVad = new VAD(VAD.Mode.AGGRESSIVE);

// Initialize SageMaker runtime client
const sagemakerClient = new SageMakerRuntimeClient({ region: AWS_REGION });

/**
 * Transcribes audio buffer using Whisper SageMaker endpoint
 * @param audioBuffer - Raw PCM audio samples (array of numbers)
 * @param channelId - Channel identifier (0 or 1)
 * @param server - Fastify server instance for logging
 * @param utteranceCount - Utterance counter for logging
 * @param periodic - Whether this is a periodic transcription
 * @returns Transcribed text string
 */
export const transcribeBuffer = async (
    audioBuffer: number[],
    channelId: string,
    server: FastifyInstance,
    utteranceCount: number,
    periodic = true
): Promise<string> => {
    server.log.debug(`[WHISPER]: Transcribing buffer for channel ${channelId}, utterance ${utteranceCount}, periodic: ${periodic}`);

    try {
        // Audio samples are already at 16kHz, convert to buffer without duplication
        const utteranceBuffer = Buffer.alloc(audioBuffer.length * 2);
        audioBuffer.forEach((sample, index) => {
            utteranceBuffer.writeInt16LE(sample, index * 2);
        });
        
        // Create WAV header
        const wavHeader = Buffer.alloc(44);
        
        // RIFF chunk descriptor
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(36 + utteranceBuffer.length, 4);
        wavHeader.write('WAVE', 8);
        
        // fmt sub-chunk
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16);
        wavHeader.writeUInt16LE(1, 20);
        wavHeader.writeUInt16LE(1, 22);
        wavHeader.writeUInt32LE(16000, 24);
        wavHeader.writeUInt32LE(16000 * 2, 28);
        wavHeader.writeUInt16LE(2, 32);
        wavHeader.writeUInt16LE(16, 34);
        
        // data sub-chunk
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(utteranceBuffer.length, 40);
        
        // Combine header and audio data
        const wavBuffer = Buffer.concat([wavHeader, utteranceBuffer]);

        if(DEBUG_WRITE_TO_S3) {
            const s3Key = `lca-audio-raw/utterance_ch${channelId}_${utteranceCount}.wav`;
            const s3Url = `s3://${OUTPUT_BUCKET}/${s3Key}`;
            console.log(`Uploading utterance to ${s3Url}`);
            
            // Upload to S3 
            try {
                await s3Client.send(new PutObjectCommand({
                    Bucket: OUTPUT_BUCKET,
                    Key: s3Key,
                    Body: wavBuffer,
                    ContentType: 'audio/wav'
                }));
                console.log(`Successfully uploaded to ${s3Url}`);
            } catch (error) {
                console.error('Error uploading to S3:', error);
            }
        }


        
        // Convert to array for JSON serialization
        const audioArray = Array.from(new Uint8Array(wavBuffer));
        
        // Create payload with audio and parameters properly structured
        const payload = {
            audio_input: audioArray,
            parameters: {
                language: 'en',
                task: 'transcribe',
                temperature: 0.0,
                no_speech_threshold: NO_SPEECH_THRESHOLD,
                beam_size: 5
            }
        };

        // Invoke SageMaker endpoint
        const response = await sagemakerClient.send(new InvokeEndpointCommand({
            EndpointName: WHISPER_SAGEMAKER_ENDPOINT,
            ContentType: 'application/json',
            Body: JSON.stringify(payload)
        }));

        // Parse the response
        const responseBody = JSON.parse(new TextDecoder().decode(response.Body));
        server.log.debug(`[WHISPER]: SageMaker response: ${JSON.stringify(responseBody)}`);

        // Check for error in response
        if (responseBody.error) {
            server.log.error(`[WHISPER]: Error from SageMaker endpoint: ${responseBody.error}`);
            return '';
        }

        // Check for no speech probability if available in the response
        if (responseBody.no_speech_prob !== undefined && responseBody.no_speech_prob > NO_SPEECH_THRESHOLD) {
            server.log.debug(`[WHISPER]: No speech detected (probability: ${responseBody.no_speech_prob})`);
            return '';
        }

        // Handle text array response
        if (Array.isArray(responseBody.text)) {
            server.log.debug(`[WHISPER]: Text array response: ${JSON.stringify(responseBody.text)}`);
            return responseBody.text.join(' ').trim();
        }

        // Handle string response
        if (typeof responseBody.text === 'string') {
            server.log.debug(`[WHISPER]: String response: ${responseBody.text}`);
            return responseBody.text.trim();
        }

        server.log.debug(`[WHISPER]: No valid text format found in response: ${JSON.stringify(responseBody)}`);

        // If no valid text format is found, return empty string
        return '';
    } catch (error) {
        server.log.error(`[WHISPER]: Error calling SageMaker endpoint: ${error}`);
        return '';
    }
};

/**
 * Creates a mock TranscribeStreamingClient that uses Whisper for transcription
 * This allows us to use the same interface as the standard Transcribe API
 */
export class WhisperStreamingClient {
    private server: FastifyInstance;
    // private resultStream: PassThrough;
    private samplingRate = 16000;
    private sessionStartTime = Date.now();
    
    // VAD-related properties (aligned with whisper.js)
    private VAD_FRAME_LENGTH = 480; // 30ms at 16kHz
    private SILENCE_THRESHOLD = 10; // 300ms of silence (10 frames) - aligned with whisper.js
    private lastTranscriptionTime = Date.now();
    private utteranceCount = 0; // Counter for unique utterance filenames
    
    // Channel tracking (using '0' and '1' to match whisper.js)
    private currentResultIds: { [key: string]: string } = { '0': '', '1': '' };
    private utteranceStartTimes: { [key: string]: number | undefined } = { '0': undefined, '1': undefined };
    private finalResultSent: { [key: string]: boolean } = { '0': false, '1': false };

    private tempDir = '/tmp/whisper';
    
    // Dynamic properties (like whisper.js)
    // [key: string]: any; // Allow dynamic properties

    private utteranceBuffers = new Map<string, number[]>();
    private voiceActive: { [key: string]: boolean } = { '0': false, '1': false };

    constructor(server: FastifyInstance, samplingRate: number) {
        this.server = server;
        this.samplingRate = samplingRate;
        this.sessionStartTime = Date.now();
        
        // Initialize result IDs
        this.currentResultIds['0'] = uuidv4();
        this.currentResultIds['1'] = uuidv4();
    }
    
    /**
     * Gets relative time from session start
     */
    private getRelativeTime(absoluteTime: number | undefined): number {
        if(absoluteTime === undefined) {
            return 0;
        }

        const relativeTime = (absoluteTime - this.sessionStartTime) / 1000;
        // Ensure we never return negative times
        return Math.max(0, relativeTime);
    }

    /**
   * Handles streaming transcription commands
   */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any) {
        this.server.log.debug('[WHISPER]: Starting Whisper streaming transcription');
    
        if(command instanceof StartStreamTranscriptionCommand) {
            return this.handleStreamTranscription(command);
        } else {
            throw new Error('Invalid command type');
        }
    }

    /**
     * Processes standard streaming transcription requests
     * Creates separate audio streams for each channel at both 8kHz and 16kHz
     * @param {StartStreamTranscriptionCommand} command - Command containing audio stream and config
     * @returns {Object} Contains transcript result stream and session ID
     */
    async handleStreamTranscription(command: StartStreamTranscriptionCommand) {
        const { 
            AudioStream, 
            // LanguageCode, 
            MediaSampleRateHertz, 
            // MediaEncoding, 
            // NumberOfChannels,
            // EnableChannelIdentification,
            // VocabularyName,
            // LanguageModelName,
            // ContentRedactionType,
            // PiiEntityTypes
        } = command.input;

        this.samplingRate = MediaSampleRateHertz || 16000;
        
        // Update to use class property
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir);
        }

        this.sessionStartTime = Date.now();

        // Update path references
        const channel0Stream16k = fs.createWriteStream(`${this.tempDir}/channel0_16k.raw`);
        const channel1Stream16k = fs.createWriteStream(`${this.tempDir}/channel1_16k.raw`);
        
        const resultStream = new PassThrough({ objectMode: true });

        // Process the incoming audio stream and generate transcripts
        this.processAudioStream(
            AudioStream as AsyncIterable<AudioStream>, 
            {
                channel0Stream16k,
                channel1Stream16k
            },
            resultStream
        );

        return {
            TranscriptResultStream: resultStream,
            SessionId: `whisper-${Date.now()}`
        };
    }

    /**
     * Core audio processing function that handles stream splitting and transcription
     * @param {ReadableStream} audioStream - Input audio stream
     * @param {Object} streams - Output file streams for different channels/rates
     * @param {PassThrough} resultStream - Stream to write transcription results
     * @param {Object} config - Processing configuration options
     */
    async processAudioStream(audioStream: AsyncIterable<AudioStream>, streams: { channel0Stream16k: WriteStream, channel1Stream16k: WriteStream }, resultStream: PassThrough) {
        // Remove VAD constants from here since they're now class properties
        let leftVadSamples: number[] = [];
        let rightVadSamples: number[] = [];
        let leftSilenceFrameCount = 0;
        let rightSilenceFrameCount = 0;
        
        try {
            for await (const chunk of audioStream) {
                if (chunk.AudioEvent && chunk.AudioEvent.AudioChunk) {
                    const audioData = chunk.AudioEvent.AudioChunk;

                    // Ensure audioData is a Buffer before processing
                    let audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);

                    if(this.samplingRate !== 16000) {
                        // Convert to 16kHz based on the sampling rate
                        const targetSampleRate = 16000;
                        const resampleRatio = targetSampleRate / this.samplingRate;
                        const originalSampleCount = audioBuffer.length / 4; // 2 bytes per sample, 2 channels
                        const targetSampleCount = Math.floor(originalSampleCount * resampleRatio);

                        const audioBufferSize = audioBuffer.length;
                        
                        // Create new buffer for resampled audio
                        const resampledBuffer = Buffer.alloc(targetSampleCount * 4); // 2 bytes per sample, 2 channels
                        
                        // Resample each stereo sample pair
                        for (let i = 0; i < targetSampleCount; i++) {
                            // Calculate the corresponding position in the original audio
                            const sourceIndex = i / resampleRatio;
                            const sourceIndexFloor = Math.floor(sourceIndex);
                            const sourceIndexCeil = Math.min(sourceIndexFloor + 1, originalSampleCount - 1);
                            const fraction = sourceIndex - sourceIndexFloor;
                            
                            // Get samples for left and right channels from source positions
                            const leftSample1 = audioBuffer.readInt16LE(sourceIndexFloor * 4);
                            const rightSample1 = audioBuffer.readInt16LE(sourceIndexFloor * 4 + 2);
                            const leftSample2 = audioBuffer.readInt16LE(sourceIndexCeil * 4);
                            const rightSample2 = audioBuffer.readInt16LE(sourceIndexCeil * 4 + 2);
                            
                            // Linear interpolation for both channels
                            const leftInterpolated = Math.round(leftSample1 + (leftSample2 - leftSample1) * fraction);
                            const rightInterpolated = Math.round(rightSample1 + (rightSample2 - rightSample1) * fraction);
                            
                            // Write interpolated samples to resampled buffer
                            resampledBuffer.writeInt16LE(leftInterpolated, i * 4);
                            resampledBuffer.writeInt16LE(rightInterpolated, i * 4 + 2);
                        }
                        
                        // Replace the original buffer with the resampled one
                        audioBuffer = resampledBuffer;
                        
                        this.server.log.debug(`[WHISPER]: Resampled audio from ${this.samplingRate}Hz to 16000Hz (${audioBufferSize} -> ${audioBuffer.length} samples)`);
                    }

                    // Split stereo PCM and upsample to 16kHz by duplicating samples
                    for (let i = 0; i < audioBuffer.length; i += 4) { // Read 2 bytes per channel
                        // Read left and right channel samples directly as signed 16-bit integers
                        const leftSample = audioBuffer.readInt16LE(i);
                        const rightSample = audioBuffer.readInt16LE(i + 2);

                        // Create buffers for each channel's sample
                        const leftBuffer = Buffer.alloc(2);
                        const rightBuffer = Buffer.alloc(2);
                        leftBuffer.writeInt16LE(leftSample, 0);
                        rightBuffer.writeInt16LE(rightSample, 0);

                        // Audio is already at 16kHz after resampling, write once per sample
                        streams.channel0Stream16k.write(leftBuffer);
                        streams.channel1Stream16k.write(rightBuffer);

                        // Add samples for VAD processing
                        leftVadSamples.push(leftSample);
                        rightVadSamples.push(rightSample);
                    }

                    // Process VAD for both channels
                    const leftResults: VadResults = await this.processChannelVAD(leftVadSamples, leftVad, '0', leftSilenceFrameCount);
                    const rightResults: VadResults = await this.processChannelVAD(rightVadSamples, rightVad, '1', rightSilenceFrameCount);
                    
                    leftVadSamples = leftResults.remainingSamples;
                    rightVadSamples = rightResults.remainingSamples;
                    leftSilenceFrameCount = leftResults.silenceFrameCount;
                    rightSilenceFrameCount = rightResults.silenceFrameCount;

                    // Only write if there are events
                    if (leftResults.TranscriptEvents && leftResults.TranscriptEvents.length > 0) {
                        this.server.log.debug(`Debug: Found ${leftResults.TranscriptEvents.length} left channel events`);
                        leftResults.TranscriptEvents.forEach((event: EventResult) => {
                            this.server.log.debug('Debug: Left channel event:', JSON.stringify(event));
                            resultStream.write(event);
                        });
                    } else {
                        this.server.log.debug('Debug: No left channel events found');
                    }
                    
                    if (rightResults.TranscriptEvents && rightResults.TranscriptEvents.length > 0) {
                        this.server.log.debug(`Debug: Found ${rightResults.TranscriptEvents.length} right channel events`);
                        rightResults.TranscriptEvents.forEach((event: EventResult) => {
                            this.server.log.debug('Debug: Right channel event:', JSON.stringify(event));
                            resultStream.write(event);
                        });
                    } else {
                        this.server.log.debug('Debug: No right channel events found');
                    }
                }
            }
        } catch (error) {
            console.error('Error processing audio stream:', error);
            resultStream.emit('error', error);
        } finally {
            // Update cleanup to use class property
            streams.channel0Stream16k.end();
            streams.channel1Stream16k.end();


            try {
                // Recursively remove all files in the directory
                const files = fs.readdirSync(this.tempDir);
                for (const file of files) {
                    fs.unlinkSync(`${this.tempDir}/${file}`);
                }
                // Now remove the empty directory
                fs.rmdirSync(this.tempDir);
            } catch (err) {
                console.error('Error cleaning up temp files:', err);
            }

            resultStream.end();
        }
    }
    
    /**
     * Processes VAD for a single channel (aligned with whisper.js)
     * @param samples - Audio samples to process
     * @param vad - VAD instance for the channel
     * @param channelId - Channel identifier (0 or 1)
     * @param silenceFrameCount - Current silence frame count
     * @returns Updated state including silence count and processed samples
     */
    private async processChannelVAD(samples: number[], vad: VadInstance, channelId: string, silenceFrameCount: number): Promise<VadResults> {
        const results = new VadResults(samples, silenceFrameCount, []);

        // Create channel-specific utterance buffer key (like whisper.js)
        const utteranceKey = `currentChannel${channelId}Utterance`;
        if (!this.utteranceBuffers.get(utteranceKey)) {
            this.utteranceBuffers.set(utteranceKey, []);
            // Generate new resultId when starting a new utterance buffer
            this.currentResultIds[channelId] = uuidv4();
        }

        // Check if it's time for periodic transcription
        const currentTime = Date.now();
        if (currentTime - this.lastTranscriptionTime >= TRANSCRIPTION_INTERVAL && 
            (this.utteranceBuffers.get(utteranceKey) || []).length > 0 && 
            this.finalResultSent[channelId] === false) {
            
            const transcribedText = await transcribeBuffer(
                this.utteranceBuffers.get(utteranceKey) || [],
                channelId,
                this.server,
                this.utteranceCount++,
                true
            );
            
            this.server.log.debug(`[WHISPER]: Periodic transcription (${channelId}): ${transcribedText}`);
            
            if (transcribedText.length > 0) {
                // Use the current resultId for this channel
                const transcriptEvent: EventResult = {
                    TranscriptEvent: {
                        Transcript: {
                            Results: [{
                                Alternatives: [{
                                    Items: transcribedText.split(' ').map((word) => {
                                        const wordDuration = 0.2;
                                        const startTime = this.getRelativeTime(this.utteranceStartTimes[channelId] || Date.now());
                                        return {
                                            Content: word,
                                            EndTime: startTime + wordDuration,
                                            StartTime: startTime,
                                            Type: word.match(/[.!?]$/) ? 'punctuation' : 'pronunciation',
                                            VocabularyFilterMatch: false
                                        };
                                    }),
                                    Transcript: transcribedText
                                }],
                                ChannelId: `ch_${channelId}`,
                                EndTime: this.getRelativeTime(Date.now()),
                                IsPartial: true,
                                ResultId: this.currentResultIds[channelId],
                                StartTime: this.getRelativeTime(this.utteranceStartTimes[channelId] || Date.now())
                            }]
                        }
                    }
                };
                results.TranscriptEvents.push(transcriptEvent);
            }
            
            this.lastTranscriptionTime = currentTime;
        }

        // Process VAD frames
        while (samples.length >= this.VAD_FRAME_LENGTH) {
            const vadBuffer = Buffer.alloc(this.VAD_FRAME_LENGTH * 2);
            for (let j = 0; j < this.VAD_FRAME_LENGTH; j++) {
                vadBuffer.writeInt16LE(samples[j], j * 2);
            }
            
            try {
                const vadResult = await vad.processAudio(vadBuffer, SAMPLE_RATE);
                
                if (vadResult === VAD.Event.VOICE) {
                    results.silenceFrameCount = 0;
                    if (!this.voiceActive[channelId]) {
                        this.server.log.debug(`[WHISPER]: Voice activity started - Channel ${channelId}`);
                        this.utteranceBuffers.set(utteranceKey, []); // Reset buffer for new utterance
                        this.currentResultIds[channelId] = uuidv4();
                        this.utteranceStartTimes[channelId] = Date.now();
                        this.server.log.debug(`[WHISPER]: Set utterance start time for channel ${channelId} to ${this.utteranceStartTimes[channelId]}`);
                        this.finalResultSent[channelId] = false;
                    }
                    // Add current samples to utterance buffer
                    this.utteranceBuffers.get(utteranceKey)?.push(...samples.slice(0, this.VAD_FRAME_LENGTH));
                    this.voiceActive[channelId] = true;
                } else if (vadResult === VAD.Event.SILENCE) {
                    results.silenceFrameCount++;
                    if (results.silenceFrameCount >= this.SILENCE_THRESHOLD) {
                        if (this.voiceActive[channelId] && (this.utteranceBuffers.get(utteranceKey) || []).length > 0) {
                            this.server.log.debug(`[WHISPER]: Processing silence-triggered transcription for channel ${channelId}`);
                            this.server.log.debug(`[WHISPER]: Current utterance start time: ${this.utteranceStartTimes[channelId]}`);
                            this.server.log.debug(`[WHISPER]: Relative start time would be: ${this.getRelativeTime(this.utteranceStartTimes[channelId] || Date.now())}`);

                            const transcribedText = await transcribeBuffer(
                                this.utteranceBuffers.get(utteranceKey) || [],
                                channelId,
                                this.server,
                                this.utteranceCount++,
                                false
                            );

                            if (transcribedText.length > 0) {
                                const startTime = this.getRelativeTime(this.utteranceStartTimes[channelId] || Date.now());
                                this.server.log.debug(`[WHISPER]: Creating transcript event for channel ${channelId} with start time ${startTime}`);
                                
                                this.finalResultSent[channelId] = true;
                                
                                const transcriptEvent: EventResult = {
                                    TranscriptEvent: {
                                        Transcript: {
                                            Results: [{
                                                Alternatives: [{
                                                    Items: transcribedText.split(' ').map((word) => {
                                                        const wordDuration = 0.2;
                                                        return {
                                                            Content: word,
                                                            EndTime: startTime + wordDuration,
                                                            StartTime: startTime,
                                                            Type: word.match(/[.!?]$/) ? 'punctuation' : 'pronunciation',
                                                            VocabularyFilterMatch: false
                                                        };
                                                    }),
                                                    Transcript: transcribedText
                                                }],
                                                ChannelId: `ch_${channelId}`,
                                                EndTime: this.getRelativeTime(Date.now()),
                                                IsPartial: false,
                                                ResultId: this.currentResultIds[channelId],
                                                StartTime: this.utteranceStartTimes[channelId] ? 
                                                    this.getRelativeTime(this.utteranceStartTimes[channelId]) : 
                                                    this.getRelativeTime(Date.now())
                                            }]
                                        }
                                    }
                                };
                                this.server.log.debug(`[WHISPER]: Transcript event: ${JSON.stringify(transcriptEvent.TranscriptEvent)}`);
                                results.TranscriptEvents.push(transcriptEvent);
                            }
                        }
                        
                        this.server.log.debug(`[WHISPER]: Resetting voice activity for channel ${channelId}`);
                        this.server.log.debug(`[WHISPER]: Previous start time: ${this.utteranceStartTimes[channelId]}`);
                        this.voiceActive[channelId] = false;
                        results.silenceFrameCount = 0;
                        this.utteranceStartTimes[channelId] = undefined;
                        this.server.log.debug(`[WHISPER]: Reset start time to: ${this.utteranceStartTimes[channelId]}`);
                    } else if (this.voiceActive[channelId]) {
                        this.utteranceBuffers.get(utteranceKey)?.push(...samples.slice(0, this.VAD_FRAME_LENGTH));
                    }
                } else if (vadResult === VAD.Event.NOISE || vadResult === VAD.Event.ERROR) {
                    this.server.log.error(`[WHISPER]: VAD processing error detected - Channel ${channelId}`);
                    this.voiceActive[channelId] = false;
                    results.silenceFrameCount = 0;
                }
            } catch (vadError) {
                this.server.log.error(`[WHISPER]: Error processing VAD for channel ${channelId}:`, vadError);
            }
            
            results.remainingSamples = samples.slice(this.VAD_FRAME_LENGTH);
            samples = results.remainingSamples;
        }

        this.server.log.debug(`[WHISPER]: VAD results: ${JSON.stringify(results)}`);

        return results;
    }
}

/**
 * Command class for standard streaming transcription
 */
export class StartStreamTranscriptionCommand {
    input: StartStreamTranscriptionCommandInput;
  
    constructor(input: StartStreamTranscriptionCommandInput) {
        this.input = input;
    }
}

/**
 * Command class for call analytics transcription
 */
export class StartCallAnalyticsStreamTranscriptionCommand {
    input: StartCallAnalyticsStreamTranscriptionCommandInput;
  
    constructor(input: StartCallAnalyticsStreamTranscriptionCommandInput) {
        this.input = input;
    }
}

// Export ParticipantRole enum to match AWS ParticipantRole
export const ParticipantRole = {
    AGENT: 'AGENT',
    CUSTOMER: 'CUSTOMER'
};
