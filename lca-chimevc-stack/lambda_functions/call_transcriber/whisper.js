// Required Node.js modules
const fs = require('fs');
const { PassThrough } = require('stream');
const VAD = require('node-vad');
const alawmulaw = require('alawmulaw');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SageMakerRuntimeClient, InvokeEndpointCommand } = require('@aws-sdk/client-sagemaker-runtime');


const { OUTPUT_BUCKET } = process.env;
const leftVad = new VAD(VAD.Mode.AGGRESSIVE);
const rightVad = new VAD(VAD.Mode.AGGRESSIVE);
const SAMPLE_RATE = 16000; // sample rate for 16kHz audio
const NO_SPEECH_THRESHOLD = parseFloat(process.env.NO_SPEECH_THRESHOLD || '0.2'); // Probability of no speech - closer to zero, better chance its speech
const TRANSCRIPTION_INTERVAL = parseInt(process.env.TRANSCRIPTION_INTERVAL || '1000'); // 1 second in milliseconds
const WHISPER_SAGEMAKER_ENDPOINT = process.env.WHISPER_SAGEMAKER_ENDPOINT || 'endpoint-quick-start-zha1f';

// Initialize S3 client
const s3Client = new S3Client({});
// Initialize SageMaker runtime client
const sagemakerClient = new SageMakerRuntimeClient({});

// Enum to match AWS ParticipantRole for consistent role mapping
const ParticipantRole = {
  AGENT: 'AGENT',
  CUSTOMER: 'CUSTOMER'
};

/**
 * Client for handling real-time audio transcription using Whisper
 * Supports both standard transcription and call analytics modes
 */
class TranscribeStreamingClient {
  constructor(config) {
    this.config = config;
    this.tempDir = '/tmp/whisper';
    this.sessionStartTime = Date.now();
    console.log(`Session started at: ${this.sessionStartTime}`);
    this.currentChannel0Utterance = [];  // Add buffer for channel 0 speech
    this.utteranceCount = 0;  // Counter for unique utterance filenames
    
    // Add VAD constants as class properties
    this.VAD_FRAME_LENGTH = 480; // 30ms at 16kHz
    this.FRAMES_PER_CHUNK = 3; // We can get 3 complete 30ms frames from 100ms
    this.SILENCE_THRESHOLD = 10; // 450ms of silence
    this.WRITE_UTTERANCE_TO_FILE = true;
    
    // Add timer tracking properties
    this.lastTranscriptionTime = Date.now();

    // Add resultId tracking for each channel
    this.currentResultIds = {
      '0': null,
      '1': null
    };

    this.utteranceStartTimes = {
      '0': null,
      '1': null
    };

    this.finalResultSent = {
      '0': false,
      '1': false
    };
  }

  getRelativeTime(absoluteTime) {
    const relativeTime = (absoluteTime - this.sessionStartTime) / 1000;
    // Ensure we never return negative times
    return Math.max(0, relativeTime);
  }

  /**
   * Handles incoming transcription commands
   * @param {Object} command - Either StartStreamTranscriptionCommand or StartCallAnalyticsStreamTranscriptionCommand
   * @returns {Promise} Returns stream transcription or call analytics results
   */
  async send(command) {
    if (command instanceof StartStreamTranscriptionCommand) {
      return this.handleStreamTranscription(command);
    } else if (command instanceof StartCallAnalyticsStreamTranscriptionCommand) {
      return this.handleCallAnalytics(command);
    }
    throw new Error('Unsupported command');
  }

  /**
   * Processes standard streaming transcription requests
   * Creates separate audio streams for each channel at both 8kHz and 16kHz
   * @param {StartStreamTranscriptionCommand} command - Command containing audio stream and config
   * @returns {Object} Contains transcript result stream and session ID
   */
  async handleStreamTranscription(command) {
    const { 
      AudioStream, 
      LanguageCode, 
      MediaSampleRateHertz, 
      MediaEncoding, 
      NumberOfChannels,
      EnableChannelIdentification,
      VocabularyName,
      LanguageModelName,
      ContentRedactionType,
      PiiEntityTypes
    } = command.input;
    
    // Update to use class property
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir);
    }

    this.sessionStartTime = Date.now();

    // Update path references
    const channel0Stream16k = fs.createWriteStream(`${this.tempDir}/channel0_16k.raw`);
    const channel1Stream16k = fs.createWriteStream(`${this.tempDir}/channel1_16k.raw`);
    
    const resultStream = new PassThrough({objectMode: true});

    // Process the incoming audio stream and generate transcripts
    this.processAudioStream(
      AudioStream, 
      {
        channel0Stream16k,
        channel1Stream16k
      },
      resultStream,
      {
        mode: 'standard',
        languageCode: LanguageCode,
        enableChannelId: EnableChannelIdentification
      }
    );

    return {
      TranscriptResultStream: resultStream,
      SessionId: `whisper-${Date.now()}`
    };
  }

  /**
   * Processes call analytics transcription requests with additional analytics features
   * @param {StartCallAnalyticsStreamTranscriptionCommand} command - Command containing audio and analytics config
   * @returns {Object} Contains analytics transcript stream and session ID
   */
  async handleCallAnalytics(command) {
    const { 
      AudioStream, 
      LanguageCode, 
      MediaSampleRateHertz, 
      MediaEncoding,
      PostCallAnalyticsSettings,
      ContentRedactionOutput
    } = command.input;
    
    // Update to use class property
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir);
    }

    // Update path references
    const channel0Stream16k = fs.createWriteStream(`${this.tempDir}/channel0_16k.raw`);
    const channel1Stream16k = fs.createWriteStream(`${this.tempDir}/channel1_16k.raw`);
    
    const resultStream = new PassThrough({objectMode: true});

    // Handle initial configuration event if present
    if (command.input.ConfigurationEvent) {
      resultStream.write({
        ConfigurationEvent: command.input.ConfigurationEvent
      });
    }

    // Process audio stream with analytics mode enabled
    this.processAudioStream(
      AudioStream, 
      {
        channel0Stream16k,
        channel1Stream16k
      },
      resultStream,
      {
        mode: 'analytics',
        languageCode: LanguageCode,
        postCallAnalytics: PostCallAnalyticsSettings
      }
    );

    return {
      CallAnalyticsTranscriptResultStream: resultStream,
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
  async processAudioStream(audioStream, streams, resultStream, config) {
    let audioChunkCount = 0;
    
    // Remove VAD constants from here since they're now class properties
    let leftVadSamples = [];
    let rightVadSamples = [];
    let leftSilenceFrameCount = 0;
    let rightSilenceFrameCount = 0;
    
    try {
      for await (const chunk of audioStream) {
        if (chunk.AudioEvent && chunk.AudioEvent.AudioChunk) {
          const audioData = chunk.AudioEvent.AudioChunk;
          audioChunkCount++;

          // Ensure audioData is a Buffer before processing
          const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);

          // // Upload audio chunk to S3 with metadata
          // const s3Params = {
          //   Bucket: OUTPUT_BUCKET,
          //   Key: `lca-raw-audio/${Date.now()}_chunk_${audioChunkCount}.raw`,
          //   Body: audioBuffer,
          //   ContentType: 'audio/x-raw',
          //   Metadata: {
          //     'chunk-number': String(audioChunkCount),
          //     'content-encoding': 'pcm_s16le',  // updated to reflect actual encoding
          //     'sample-rate': '8000',
          //     'channels': '2'
          //   }
          // };
          
          // try {
          //   await s3Client.send(new PutObjectCommand(s3Params));
          //   console.log(`Successfully uploaded audio chunk ${audioChunkCount} to S3 (size: ${audioBuffer.length} bytes)`);
          // } catch (error) {
          //   console.error('Error uploading audio chunk to S3:', error);
          // }

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

            // Write each sample twice to achieve 16kHz
            streams.channel0Stream16k.write(leftBuffer);
            streams.channel0Stream16k.write(leftBuffer);
            streams.channel1Stream16k.write(rightBuffer);
            streams.channel1Stream16k.write(rightBuffer);

            // Add samples for VAD processing
            leftVadSamples.push(leftSample);
            rightVadSamples.push(rightSample);
          }

          // Process VAD for both channels
          const leftResults = await this.processChannelVAD(leftVadSamples, leftVad, '0', leftSilenceFrameCount);
          const rightResults = await this.processChannelVAD(rightVadSamples, rightVad, '1', rightSilenceFrameCount);
          
          leftVadSamples = leftResults.remainingSamples;
          rightVadSamples = rightResults.remainingSamples;
          leftSilenceFrameCount = leftResults.silenceFrameCount;
          rightSilenceFrameCount = rightResults.silenceFrameCount;

          // Only write if there are events
          if (leftResults.TranscriptEvents && leftResults.TranscriptEvents.length > 0) {
            console.log(`Debug: Found ${leftResults.TranscriptEvents.length} left channel events`);
            leftResults.TranscriptEvents.forEach(event => {
              console.log('Debug: Left channel event:', JSON.stringify(event));
              resultStream.write(event);
            });
          } else {
            console.log('Debug: No left channel events found');
          }
          
          if (rightResults.TranscriptEvents && rightResults.TranscriptEvents.length > 0) {
            console.log(`Debug: Found ${rightResults.TranscriptEvents.length} right channel events`);
            rightResults.TranscriptEvents.forEach(event => {
              console.log('Debug: Right channel event:', JSON.stringify(event));
              resultStream.write(event);
            });
          } else {
            console.log('Debug: No right channel events found');
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
   * Processes VAD for a single channel
   * @param {number[]} samples - Audio samples to process
   * @param {VAD} vad - VAD instance for the channel
   * @param {string} channelId - Channel identifier (0 or 1)
   * @param {number} silenceFrameCount - Current silence frame count
   * @returns {Object} Updated state including silence count and processed samples
   */
  async processChannelVAD(samples, vad, channelId, silenceFrameCount) {
    const results = {
      remainingSamples: samples,
      silenceFrameCount: silenceFrameCount,
      TranscriptEvents: []
    };

    // Create channel-specific utterance buffer key
    const utteranceKey = `currentChannel${channelId}Utterance`;
    if (!this[utteranceKey]) {
      this[utteranceKey] = [];
      // Generate new resultId when starting a new utterance buffer
      this.currentResultIds[channelId] = crypto.randomUUID();
    }

    // Check if it's time for periodic transcription
    const currentTime = Date.now();
    if (currentTime - this.lastTranscriptionTime >= TRANSCRIPTION_INTERVAL && this[utteranceKey].length > 0 && this.finalResultSent[channelId] === false) {
      const transcribedText = await transcribeBuffer(
        this[utteranceKey],
        channelId,
        this.tempDir,
        this.utteranceCount++,
        true
      );
      console.log(`Periodic transcription (${channelId}):`, transcribedText);
      if(transcribedText.length > 0) {
        // Use the current resultId for this channel
        const transcriptEvent = {
          TranscriptEvent: {
            Transcript: {
              Results: [{
                Alternatives: [{
                  Items: transcribedText.split(' ').map((word, index) => {
                    const wordDuration = 0.2;
                    const startTime = this.getRelativeTime(this.utteranceStartTimes[channelId]);
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
                StartTime: this.getRelativeTime(this.utteranceStartTimes[channelId])
              }]
            }
          }
        };
        results.TranscriptEvents.push(transcriptEvent);
      }
      
      this.lastTranscriptionTime = currentTime;
    }

    while (samples.length >= this.VAD_FRAME_LENGTH) {
      const vadBuffer = Buffer.alloc(this.VAD_FRAME_LENGTH * 2);
      for (let j = 0; j < this.VAD_FRAME_LENGTH; j++) {
        vadBuffer.writeInt16LE(samples[j], j * 2);
      }

      try {
        const vadResult = await vad.processAudio(vadBuffer, SAMPLE_RATE);
        const voiceActiveKey = `channel${channelId}VoiceActive`;
        
        if (vadResult === VAD.Event.VOICE) {
          results.silenceFrameCount = 0;
          if (!this[voiceActiveKey]) {
            console.log(`Voice activity started - Channel ${channelId}`);
            this[utteranceKey] = []; // Reset buffer for new utterance
            this.currentResultIds[channelId] = crypto.randomUUID();
            this.utteranceStartTimes[channelId] = Date.now();
            console.log(`Set utterance start time for channel ${channelId} to ${this.utteranceStartTimes[channelId]}`);
            this.finalResultSent[channelId] = false;
          }
          // Add current samples to utterance buffer
          this[utteranceKey].push(...samples.slice(0, this.VAD_FRAME_LENGTH));
          this[voiceActiveKey] = true;
        } else if (vadResult === VAD.Event.SILENCE) {
          results.silenceFrameCount++;
          if (results.silenceFrameCount >= this.SILENCE_THRESHOLD) {
            if (this[voiceActiveKey] && this[utteranceKey].length > 0) {
              console.log(`Processing silence-triggered transcription for channel ${channelId}`);
              console.log(`Current utterance start time: ${this.utteranceStartTimes[channelId]}`);
              console.log(`Relative start time would be: ${this.getRelativeTime(this.utteranceStartTimes[channelId])}`);

              const transcribedText = await transcribeBuffer(
                this[utteranceKey],
                channelId,
                this.tempDir,
                this.utteranceCount++,
                false
              );

              if(transcribedText.length > 0) {
                const startTime = this.getRelativeTime(this.utteranceStartTimes[channelId]);
                console.log(`Creating transcript event for channel ${channelId} with start time ${startTime}`);
                
                this.finalResultSent[channelId] = true;
                
                const transcriptEvent = {
                  TranscriptEvent: {
                    Transcript: {
                      Results: [{
                        Alternatives: [{
                          Items: transcribedText.split(' ').map((word, index) => {
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
                results.TranscriptEvents.push(transcriptEvent);
              }
            }
            
            console.log(`Resetting voice activity for channel ${channelId}`);
            console.log(`Previous start time: ${this.utteranceStartTimes[channelId]}`);
            this[voiceActiveKey] = false;
            results.silenceFrameCount = 0;
            this.utteranceStartTimes[channelId] = null;
            console.log(`Reset start time to: ${this.utteranceStartTimes[channelId]}`);
          } else if (this[voiceActiveKey]) {
            this[utteranceKey].push(...samples.slice(0, this.VAD_FRAME_LENGTH));
          }
        } else if (vadResult === VAD.Event.NOISE || vadResult === VAD.Event.ERROR) {
          console.error(`VAD processing error detected - Channel ${channelId}`);
          this[voiceActiveKey] = false;
          results.silenceFrameCount = 0;
        }
      } catch (vadError) {
        console.error(`Error processing VAD for channel ${channelId}:`, vadError);
      }
      results.remainingSamples = samples.slice(this.VAD_FRAME_LENGTH);
      samples = results.remainingSamples;
    }

    return results;
  }
}

/**
 * Command class for standard streaming transcription
 */
class StartStreamTranscriptionCommand {
  constructor(input) {
    this.input = input;
  }
}

/**
 * Command class for call analytics transcription
 */
class StartCallAnalyticsStreamTranscriptionCommand {
  constructor(input) {
    this.input = input;
  }
}

function mulawToPcm(mulawSample) {
    return alawmulaw.mulaw.decodeSample(mulawSample);
}

async function transcribeBuffer(audioBuffer, channelId, tempDir, utteranceCount, periodic=true) {
  // Double the buffer size since we need to write each sample twice for 16kHz
  const utteranceBuffer = Buffer.alloc(audioBuffer.length * 4);
  audioBuffer.forEach((sample, index) => {
    // Write each sample twice to achieve 16kHz
    utteranceBuffer.writeInt16LE(sample, index * 4);
    utteranceBuffer.writeInt16LE(sample, (index * 4) + 2);
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

  const utteranceFile = `${tempDir}/utterance_ch${channelId}_${utteranceCount}.wav`;
  fs.writeFileSync(utteranceFile, wavBuffer);
  console.log(`Wrote utterance to ${utteranceFile}`);

  if(!periodic) {
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

  try {
    // Create payload with audio and parameters
    const payload = {
      audio: Array.from(wavBuffer),  // Convert buffer to array
      parameters: {
        language: "en",              // Specify language
        task: "transcribe",          // transcribe or translate
        temperature: 0.0,            // Lower temperature for more focused sampling
        no_speech_threshold: NO_SPEECH_THRESHOLD,
        // Add any other parameters your endpoint supports
      }
    };

    // Invoke SageMaker endpoint
    const response = await sagemakerClient.send(new InvokeEndpointCommand({
      EndpointName: WHISPER_SAGEMAKER_ENDPOINT,
      ContentType: 'application/json',  // Changed to JSON
      Body: JSON.stringify(payload)
    }));

    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(response.Body));
    console.log('SageMaker response:', responseBody);

    // Check for no speech probability if available in the response
    if (responseBody.no_speech_prob !== undefined && responseBody.no_speech_prob > NO_SPEECH_THRESHOLD) {
      return '';
    }

    // Handle text array response
    if (Array.isArray(responseBody.text)) {
      return responseBody.text.join(' ').trim();
    }

    // Handle string response
    if (typeof responseBody.text === 'string') {
      return responseBody.text.trim();
    }

    // If no valid text format is found, return empty string
    return 'Error with transcription';
  } catch (error) {
    console.error('Error calling SageMaker endpoint:', error);
    return '';
  }

  return 'Error with transcription';
}

module.exports = {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  StartCallAnalyticsStreamTranscriptionCommand,
  ParticipantRole
}; 