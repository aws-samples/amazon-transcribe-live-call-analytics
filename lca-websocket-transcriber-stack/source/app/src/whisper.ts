// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/brace-style */

import { SageMakerRuntimeClient, InvokeEndpointCommand } from '@aws-sdk/client-sagemaker-runtime';
import { v4 as uuidv4 } from 'uuid';
import { TranscriptEvent, StartStreamTranscriptionCommandInput, StartCallAnalyticsStreamTranscriptionCommandInput } from '@aws-sdk/client-transcribe-streaming';
import { FastifyInstance } from 'fastify';
import { createWavHeader } from './utils';
import { PassThrough } from 'stream';
// Define a type for VAD to avoid using @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VAD = require('node-vad');

// Define VAD types
interface VadInstance {
    processAudio(buffer: Buffer, sampleRate: number): Promise<number>;
}

const AWS_REGION = process.env['AWS_REGION'] || 'us-east-1';
const WHISPER_SAGEMAKER_ENDPOINT = process.env['WHISPER_SAGEMAKER_ENDPOINT'] || '';
const NO_SPEECH_THRESHOLD = parseFloat(process.env['NO_SPEECH_THRESHOLD'] || '0.2');
const TRANSCRIPTION_INTERVAL = parseInt(process.env['TRANSCRIPTION_INTERVAL'] || '5000'); // 5 seconds in milliseconds
const SAMPLE_RATE = 16000; // 16kHz audio

// Initialize VAD instances for each channel
const leftVad = new VAD(VAD.Mode.AGGRESSIVE);
const rightVad = new VAD(VAD.Mode.AGGRESSIVE);

// Initialize SageMaker runtime client
const sagemakerClient = new SageMakerRuntimeClient({ region: AWS_REGION });

/**
 * Transcribes audio using Whisper SageMaker endpoint
 * @param audioBuffer - Raw PCM audio buffer
 * @param channelId - Channel identifier (ch_0 or ch_1)
 * @param server - Fastify server instance for logging
 * @returns TranscriptEvent compatible with the standard Transcribe API
 */
export const transcribeWithWhisper = async (
    audioBuffer: Buffer,
    channelId: string,
    server: FastifyInstance
): Promise<TranscriptEvent | null> => {
    server.log.debug(`[WHISPER]: Transcribing with Whisper for channel ${channelId}`);

    // eslint-disable-next-line @typescript-eslint/brace-style
    try {
        // Create WAV header for 16kHz mono audio
        const sampleRate = 16000;
        const wavHeader = createWavHeader(sampleRate, audioBuffer.length);
    
        // Combine header and audio data
        const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
    
        // Convert to array for JSON serialization
        const audioArray = Array.from(new Uint8Array(wavBuffer));
    
        // Create payload with audio and parameters
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
            return null;
        }

        // Check for no speech probability if available in the response
        if (responseBody.no_speech_prob !== undefined && responseBody.no_speech_prob > NO_SPEECH_THRESHOLD) {
            server.log.debug(`[WHISPER]: No speech detected (probability: ${responseBody.no_speech_prob})`);
            return null;
        }

        // Extract transcription text
        let transcription = '';
    
        // Handle text array response
        if (Array.isArray(responseBody.text)) {
            transcription = responseBody.text.join(' ').trim();
        }
        // Handle string response
        else if (typeof responseBody.text === 'string') {
            transcription = responseBody.text.trim();
        }

        if (!transcription) {
            server.log.debug('[WHISPER]: No transcription text in response');
            return null;
        }
        server.log.debug(`[WHISPER]: Transcription: ${transcription}`);

        // Create a TranscriptEvent compatible with the standard Transcribe API
        const now = Date.now() / 1000; // Current time in seconds
        const resultId = uuidv4();
    
        return {
            Transcript: {
                Results: [
                    {
                        Alternatives: [
                            {
                                Transcript: transcription,
                                Items: transcription.split(' ').map((word) => {
                                    const wordDuration = 0.2;
                                    return {
                                        Content: word,
                                        EndTime: now + wordDuration,
                                        StartTime: now,
                                        Type: word.match(/[.!?]$/) ? 'punctuation' : 'pronunciation',
                                        VocabularyFilterMatch: false
                                    };
                                }),
                            }
                        ],
                        ChannelId: channelId,
                        EndTime: now,
                        IsPartial: false,
                        ResultId: resultId,
                        StartTime: now - 5 // Assume 5 second duration
                    }
                ]
            }
        };
    } catch (error) {
        server.log.error(`[WHISPER]: Error transcribing with Whisper: ${error}`);
        return null;
    }
};

/**
 * Creates a mock TranscribeStreamingClient that uses Whisper for transcription
 * This allows us to use the same interface as the standard Transcribe API
 */
export class WhisperStreamingClient {
    private server: FastifyInstance;
    private audioBuffers: { [key: string]: Buffer[] } = { 'ch_0': [], 'ch_1': [] };
    private resultStream: PassThrough;
    private processingInterval: NodeJS.Timeout | null = null;
    private isProcessing = false;
    
    // VAD-related properties
    private vadFrameLength = 480; // 30ms at 16kHz
    private silenceThreshold = 100; // 1500ms of silence (50 frames)
    private vadSamples: { [key: string]: number[] } = { 'ch_0': [], 'ch_1': [] };
    private silenceFrameCount: { [key: string]: number } = { 'ch_0': 0, 'ch_1': 0 };
    private voiceActive: { [key: string]: boolean } = { 'ch_0': false, 'ch_1': false };
    private utteranceBuffers: { [key: string]: number[] } = { 'ch_0': [], 'ch_1': [] };
    private utteranceStartTimes: { [key: string]: number | null } = { 'ch_0': null, 'ch_1': null };
    private currentResultIds: { [key: string]: string } = { 'ch_0': '', 'ch_1': '' };
    private lastTranscriptionTime = Date.now();
    private sessionStartTime = Date.now();
    private finalResultSent: { [key: string]: boolean } = { 'ch_0': false, 'ch_1': false };
  
    constructor(server: FastifyInstance) {
        this.server = server;
        this.sessionStartTime = Date.now();
        
        // Initialize result IDs
        this.currentResultIds['ch_0'] = uuidv4();
        this.currentResultIds['ch_1'] = uuidv4();
    }
    
    /**
     * Gets relative time from session start
     */
    private getRelativeTime(absoluteTime: number): number {
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
    
        // Extract audio stream from command
        const { AudioStream } = command.input;
    
        // Create a result stream
        this.resultStream = new PassThrough({ objectMode: true });
    
        // Process the audio stream
        this.processAudioStream(AudioStream);
    
        // Start processing audio buffers at regular intervals
        this.startProcessingInterval();
    
        return {
            TranscriptResultStream: this.resultStream,
            SessionId: `whisper-${Date.now()}`
        };
    }

    /**
     * Processes the incoming audio stream
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async processAudioStream(audioStream: any) {
        try {
            for await (const chunk of audioStream) {
                if (chunk.AudioEvent && chunk.AudioEvent.AudioChunk) {
                    const audioData = chunk.AudioEvent.AudioChunk;
          
                    // Ensure audioData is a Buffer
                    const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
          
                    // Split stereo PCM into separate channels
                    for (let i = 0; i < audioBuffer.length; i += 4) {
                        // Read left and right channel samples as signed 16-bit integers
                        const leftSample = audioBuffer.readInt16LE(i);
                        const rightSample = audioBuffer.readInt16LE(i + 2);
            
                        // Create buffers for each channel's sample
                        const leftBuffer = Buffer.alloc(2);
                        const rightBuffer = Buffer.alloc(2);
                        leftBuffer.writeInt16LE(leftSample, 0);
                        rightBuffer.writeInt16LE(rightSample, 0);
            
                        // Add samples to respective channel buffers
                        this.audioBuffers['ch_0'].push(leftBuffer);
                        this.audioBuffers['ch_1'].push(rightBuffer);
                        
                        // Add samples for VAD processing
                        this.vadSamples['ch_0'].push(leftSample);
                        this.vadSamples['ch_1'].push(rightSample);
                    }
                    
                    // Process VAD for both channels
                    await this.processChannelVAD('ch_0', leftVad);
                    await this.processChannelVAD('ch_1', rightVad);
                }
            }
        } catch (error) {
            this.server.log.error(`[WHISPER]: Error processing audio stream: ${error}`);
            this.resultStream.emit('error', error);
        } finally {
            this.stopProcessingInterval();
            this.resultStream.end();
        }
    }
    
    /**
     * Processes VAD for a single channel
     * @param channelId - Channel identifier (ch_0 or ch_1)
     * @param vad - VAD instance for the channel
     */
    private async processChannelVAD(channelId: string, vad: VadInstance) {
        // Check if it's time for periodic transcription
        const currentTime = Date.now();
        if (currentTime - this.lastTranscriptionTime >= TRANSCRIPTION_INTERVAL && 
            this.utteranceBuffers[channelId].length > 0 && 
            !this.finalResultSent[channelId]) {
            
            // Create buffer from utterance samples
            const sampleBuffer = Buffer.alloc(this.utteranceBuffers[channelId].length * 2);
            this.utteranceBuffers[channelId].forEach((sample, index) => {
                sampleBuffer.writeInt16LE(sample, index * 2);
            });
            
            this.server.log.debug(`[WHISPER]: Periodic transcription for channel ${channelId}`);
            
            // Transcribe the audio
            const transcriptEvent = await this.createTranscriptEvent(
                sampleBuffer, 
                channelId, 
                this.utteranceStartTimes[channelId] || currentTime,
                true // isPartial
            );
            
            // If we got a result, emit it
            if (transcriptEvent) {
                this.resultStream.write({ TranscriptEvent: transcriptEvent });
            }
            
            this.lastTranscriptionTime = currentTime;
        }
        
        // Process VAD frames
        while (this.vadSamples[channelId].length >= this.vadFrameLength) {
            const vadBuffer = Buffer.alloc(this.vadFrameLength * 2);
            for (let j = 0; j < this.vadFrameLength; j++) {
                vadBuffer.writeInt16LE(this.vadSamples[channelId][j], j * 2);
            }
            
            try {
                const vadResult = await vad.processAudio(vadBuffer, SAMPLE_RATE);
                
                if (vadResult === VAD.Event.VOICE) {
                    this.silenceFrameCount[channelId] = 0;
                    
                    if (!this.voiceActive[channelId]) {
                        this.server.log.debug(`[WHISPER]: Voice activity started - Channel ${channelId}`);
                        this.utteranceBuffers[channelId] = []; // Reset buffer for new utterance
                        this.currentResultIds[channelId] = uuidv4();
                        this.utteranceStartTimes[channelId] = Date.now();
                        this.finalResultSent[channelId] = false;
                    }
                    
                    // Add current samples to utterance buffer
                    this.utteranceBuffers[channelId].push(...this.vadSamples[channelId].slice(0, this.vadFrameLength));
                    this.voiceActive[channelId] = true;
                } 
                else if (vadResult === VAD.Event.SILENCE) {
                    this.silenceFrameCount[channelId]++;
                    
                    if (this.silenceFrameCount[channelId] >= this.silenceThreshold) {
                        if (this.voiceActive[channelId] && this.utteranceBuffers[channelId].length > 0) {
                            this.server.log.debug(`[WHISPER]: Processing silence-triggered transcription for channel ${channelId}`);
                            
                            // Create buffer from utterance samples
                            const sampleBuffer = Buffer.alloc(this.utteranceBuffers[channelId].length * 2);
                            this.utteranceBuffers[channelId].forEach((sample, index) => {
                                sampleBuffer.writeInt16LE(sample, index * 2);
                            });
                            
                            // Transcribe the audio
                            const transcriptEvent = await this.createTranscriptEvent(
                                sampleBuffer, 
                                channelId, 
                                this.utteranceStartTimes[channelId] || Date.now(),
                                false // not partial
                            );
                            
                            // If we got a result, emit it
                            if (transcriptEvent) {
                                this.finalResultSent[channelId] = true;
                                this.resultStream.write({ TranscriptEvent: transcriptEvent });
                            }
                        }
                        
                        this.server.log.debug(`[WHISPER]: Resetting voice activity for channel ${channelId}`);
                        this.voiceActive[channelId] = false;
                        this.silenceFrameCount[channelId] = 0;
                        this.utteranceStartTimes[channelId] = null;
                    } 
                    else if (this.voiceActive[channelId]) {
                        this.utteranceBuffers[channelId].push(...this.vadSamples[channelId].slice(0, this.vadFrameLength));
                    }
                }
            } catch (vadError) {
                this.server.log.error(`[WHISPER]: Error processing VAD for channel ${channelId}:`, vadError);
            }
            
            // Remove processed samples
            this.vadSamples[channelId] = this.vadSamples[channelId].slice(this.vadFrameLength);
        }
    }
    
    /**
     * Creates a transcript event from audio buffer
     * @param audioBuffer - Audio buffer to transcribe
     * @param channelId - Channel identifier
     * @param startTime - Utterance start time
     * @param isPartial - Whether this is a partial result
     * @returns TranscriptEvent or null if transcription failed
     */
    private async createTranscriptEvent(
        audioBuffer: Buffer, 
        channelId: string, 
        startTime: number,
        isPartial: boolean
    ): Promise<TranscriptEvent | null> {
        try {
            // Transcribe the audio
            const transcriptEvent = await transcribeWithWhisper(audioBuffer, channelId, this.server);
            
            if (transcriptEvent && transcriptEvent.Transcript && transcriptEvent.Transcript.Results) {
                // Update the result with correct timing and partial flag
                transcriptEvent.Transcript.Results[0].IsPartial = isPartial;
                transcriptEvent.Transcript.Results[0].ResultId = this.currentResultIds[channelId];
                transcriptEvent.Transcript.Results[0].StartTime = this.getRelativeTime(startTime);
                transcriptEvent.Transcript.Results[0].EndTime = this.getRelativeTime(Date.now());
                
                return transcriptEvent;
            }
            
            return null;
        } catch (error) {
            this.server.log.error(`[WHISPER]: Error creating transcript event: ${error}`);
            return null;
        }
    }

    /**
   * Starts the interval to process accumulated audio buffers
   */
    private startProcessingInterval() {
    // Process audio at the same interval as transcription
        this.processingInterval = setInterval(() => {
            this.processAccumulatedAudio();
        }, TRANSCRIPTION_INTERVAL);
    }

    /**
   * Stops the processing interval
   */
    private stopProcessingInterval() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
    }

    /**
   * Processes accumulated audio for both channels
   */
    private async processAccumulatedAudio() {
        if (this.isProcessing) {
            return;
        }
        this.isProcessing = true;
    
        try {
            // Process each channel
            for (const channelId of ['ch_0', 'ch_1']) {
                const buffers = this.audioBuffers[channelId];
        
                // Only process if we have enough audio data (at least 1 second at 16kHz with 32k buffer)
                if (buffers.length > 32000) {
                    // Combine all buffers for this channel
                    const combinedBuffer = Buffer.concat(buffers);
          
                    // Clear the buffer after processing
                    this.audioBuffers[channelId] = [];
          
                    // Transcribe the audio
                    const transcriptEvent = await transcribeWithWhisper(combinedBuffer, channelId, this.server);
          
                    // If we got a result, emit it
                    if (transcriptEvent) {
                        this.resultStream.write({ TranscriptEvent: transcriptEvent });
                    }
                }
            }
        } catch (error) {
            this.server.log.error(`[WHISPER]: Error in processAccumulatedAudio: ${error}`);
        } finally {
            this.isProcessing = false;
        }
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
