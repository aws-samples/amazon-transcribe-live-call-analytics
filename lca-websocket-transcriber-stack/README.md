# Websocket Server for Amazon Transcribe Live Call Analytics

## Introduction
This WebSocket server ingests audio from web clients (web and microphone audio streams), transcribes the audio in real-time, and writes the transcription events to Amazon Kinesis Data Streams (KDS). The server supports multiple transcription engines including Amazon Transcribe, Amazon Transcribe Call Analytics, and OpenAI's Whisper model deployed on Amazon SageMaker.

## Architecture
![Architecture Diagram](../images/lca-genesys-architecture.png)

## Transcription Engine Options

The WebSocket server supports three transcription API modes:

1. **Standard** - Uses Amazon Transcribe's standard streaming API
2. **Analytics** - Uses Amazon Transcribe Call Analytics for enhanced features like call categories and sentiment analysis
3. **Whisper-on-SageMaker** - Uses OpenAI's Whisper model deployed on Amazon SageMaker for transcription

### Whisper on SageMaker Integration

The WebSocket server can use a Whisper model deployed on SageMaker as an alternative transcription engine. This integration:

- Emulates the Amazon Transcribe API interface for seamless integration with LCA
- Processes audio using Voice Activity Detection (VAD) to identify speech segments
- Sends audio chunks to the Whisper SageMaker endpoint for transcription
- Formats responses to match the Amazon Transcribe output structure

#### Key Features of Whisper Integration

- **Voice Activity Detection (VAD)**: Uses `node-vad` to detect speech segments and reduce unnecessary processing
- **Dual-Channel Support**: Processes left and right audio channels separately for agent/customer transcription
- **Partial Results**: Supports partial transcription results for low-latency user experience
- **Configurable Parameters**: Allows customization of silence thresholds and transcription intervals

## CloudFormation Deployment

The WebSocket server is an optional component of the main LCA solution. You can deploy this component by enabling the `WebSocketAudioInput` parameter in the LCA main stack.

The CloudFormation stack deploys the WebSocket server to ECS Fargate and creates an endpoint used by the web client. Check `LCAWebsocketEndpoint` in the `Outputs` section of the CloudFormation stack.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| TRANSCRIBE_API_MODE | Transcription engine to use (`standard`, `analytics`, or `whisper-on-sagemaker`) | `standard` |
| WHISPER_SAGEMAKER_ENDPOINT | Name of the SageMaker endpoint running Whisper (required when using `whisper-on-sagemaker` mode) | - |
| NO_SPEECH_THRESHOLD | Threshold for no-speech probability in Whisper (higher values are more aggressive at filtering silence) | `0.2` |
| TRANSCRIPTION_INTERVAL | Interval for partial results in milliseconds | `5000` |
| TRANSCRIBE_LANGUAGE_CODE | Language code for transcription | `en-US` |
| TRANSCRIBE_LANGUAGE_OPTIONS | Comma-separated list of language options for language identification | `en-US,es-US` |
| TRANSCRIBE_PREFERRED_LANGUAGE | Preferred language for language identification | `None` |
| IS_CONTENT_REDACTION_ENABLED | Enable content redaction | `false` |
| CONTENT_REDACTION_TYPE | Type of content to redact | `PII` |
| TRANSCRIBE_PII_ENTITY_TYPES | Types of PII entities to redact | - |
| CUSTOM_VOCABULARY_NAME | Custom vocabulary name | - |
| CUSTOM_LANGUAGE_MODEL_NAME | Custom language model name | - |

### Using Whisper on SageMaker

To use Whisper as the transcription engine:

1. Deploy the Whisper SageMaker stack (see the lca-whisper-sagemaker-stack README)
2. Set `TRANSCRIBE_API_MODE` to `whisper-on-sagemaker`
3. Set `WHISPER_SAGEMAKER_ENDPOINT` to the name of your deployed SageMaker endpoint

## WebSocket Protocol

The WebSocket API supports the following message types:

### Client to Server

- `startCall`: Initiates a new call session
  ```json
  {
    "action": "startCall",
    "callId": "unique-call-identifier",
    "fromNumber": "+15551234567",
    "toNumber": "+15557654321",
    "languageCode": "en-US",
    "streamingConfig": {
      "transcribeApiMode": "standard|analytics|whisper-on-sagemaker",
      "transcribeLanguageOptions": "en-US,es-US",
      "transcribePreferredLanguage": "en-US",
      "transcribeCustomVocabulary": "my-vocabulary",
      "transcribeCustomLanguageModel": "my-language-model",
      "transcribeContentRedactionType": "PII",
      "transcribePiiEntityTypes": "NAME,ADDRESS,PHONE",
      "isPartialTranscriptEnabled": true,
      "isContentRedactionEnabled": false
    }
  }
  ```

- `audioMessage`: Sends audio data for transcription
  ```json
  {
    "action": "audioMessage",
    "callId": "unique-call-identifier",
    "audio": "base64-encoded-audio-data",
    "isAgentAudio": true
  }
  ```

- `endCall`: Terminates the call session
  ```json
  {
    "action": "endCall",
    "callId": "unique-call-identifier"
  }
  ```

### Server to Client

- `transcriptEvent`: Delivers transcription results
  ```json
  {
    "action": "transcriptEvent",
    "callId": "unique-call-identifier",
    "transcript": {
      "ResultId": "result-id",
      "IsPartial": false,
      "ChannelId": 0,
      "StartTime": 1234567890,
      "EndTime": 1234567899,
      "Transcript": "Transcribed text",
      "Sentiment": "POSITIVE",
      "Items": [...]
    }
  }
  ```

- `callEvent`: Provides call status updates
  ```json
  {
    "action": "callEvent",
    "callId": "unique-call-identifier",
    "event": "call-started|call-ended|error",
    "message": "Additional information"
  }
  ```

## Testing

The WebSocket server can be tested by streaming a call recording using a node client utility. Check `utilities/websocket-client` for an example client implementation.

