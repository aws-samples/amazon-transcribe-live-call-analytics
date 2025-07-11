# Whisper-based Live Call Analytics Transcription

This implementation provides real-time transcription capabilities for Live Call Analytics (LCA) using OpenAI's Whisper model deployed on Amazon SageMaker, as an alternative to Amazon Transcribe.

## Overview

The solution emulates Amazon Transcribe's streaming API behavior while using a Whisper model endpoint on SageMaker for speech-to-text conversion. This approach provides:

- Real-time transcription of audio streams
- Support for dual-channel audio (agent/customer)
- Voice Activity Detection (VAD) for speech segmentation
- Partial and final transcription results
- Integration with the existing LCA infrastructure

## Architecture

The system consists of several key components:

1. **Voice Activity Detection (VAD)**: Uses `node-vad` for accurate speech detection and segmentation
2. **Audio Processing**: Handles stereo channel splitting and audio format conversion
3. **Whisper Integration**: Communicates with a SageMaker endpoint running Whisper
4. **Transcription Management**: Emulates Transcribe's streaming API response format

## Prerequisites

- A deployed Whisper model endpoint on Amazon SageMaker. This was tested with the Whisper Large V3 Turbo model from Amazon Bedrock.
- Docker installed for building the Lambda container
- AWS CLI configured with appropriate permissions

## Configuration

The following environment variables can be configured:

- `WHISPER_SAGEMAKER_ENDPOINT`: Name of your SageMaker endpoint running Whisper
- `NO_SPEECH_THRESHOLD`: Threshold for no-speech probability, signifying a new utterance (default: 0.2)
- `TRANSCRIPTION_INTERVAL`: Interval for partial results in milliseconds (default: 1000)

## Docker Setup

The solution requires a custom Docker container due to the `node-vad` dependency, which needs specific system libraries. See the [Dockerfile](./Dockerfile) for details.

## How It Works

1. **Audio Stream Processing**:
   - Incoming audio is split into left and right channels
   - Each channel is processed through VAD to detect speech segments
   - Audio is converted to the appropriate format for Whisper

2. **Speech Detection**:
   - `node-vad` analyzes audio frames for speech activity
   - Configurable silence threshold for utterance segmentation
   - Maintains separate buffers for each channel

3. **Transcription Process**:
   - Speech segments are sent to the Whisper SageMaker endpoint
   - Results are formatted to match Transcribe's response structure
   - Partial results are emitted at configured intervals

## Limitations

- Whisper may have different latency characteristics and accuracy compared to Amazon Transcribe
- Some Transcribe-specific features such as custom vocabularies and language models are not supported

## Troubleshooting

Common issues and solutions:

1. **SageMaker Endpoint Issues**:
   - Verify endpoint name and region
   - Check IAM permissions for Lambda
   - Monitor endpoint metrics for performance

3. **Audio Processing Issues**:
   - Verify audio format and sample rate
   - Check VAD sensitivity settings
   - Monitor memory usage for large audio buffers
   - Experiment with no-speech thresholds and transcription intervals