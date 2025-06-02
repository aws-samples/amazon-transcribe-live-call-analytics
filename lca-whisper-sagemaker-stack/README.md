# Amazon Transcribe Live Call Analytics - Whisper on SageMaker Integration

This CloudFormation stack deploys OpenAI's Whisper speech-to-text model on Amazon SageMaker for integration with Amazon Transcribe Live Call Analytics (LCA). It provides an alternative transcription engine using Whisper's state-of-the-art speech recognition capabilities.

## Overview

The Whisper SageMaker stack enables the use of OpenAI's Whisper model as an alternative to Amazon Transcribe for real-time call transcription in the LCA solution. This stack handles the deployment and configuration of a Whisper model on Amazon SageMaker, making it available as an endpoint that can be used for real-time transcription.

## Integration with LCA

This stack integrates with the main LCA solution when the `TranscribeApiMode` parameter is set to `whisper-on-sagemaker`. It's compatible with the following call audio sources:
- Demo Asterisk PBX Server
- Amazon Chime SDK Voice Connector (SIPREC)

And requires the Call Audio Processor to be set to `Call Transcriber Lambda`.

## Architecture

The stack creates the following resources:

- **SageMaker Endpoint**: Hosts the Whisper model for inference
- **Lambda Function**: Handles the deployment of the Whisper model to SageMaker
- **IAM Roles**: Provides necessary permissions for Lambda and SageMaker
- **S3 Bucket** (optional): Stores model artifacts
- **Auto Scaling Configuration** (optional): Dynamically adjusts endpoint capacity based on load

### Components

#### Lambda Function (deploy_whisper)

The `deploy_whisper` Lambda function is responsible for:
- Downloading and preparing the Whisper model files
- Creating a model archive and uploading it to S3
- Creating and deploying the SageMaker model, endpoint configuration, and endpoint
- Managing the lifecycle of the SageMaker resources

#### Inference Script (inference.py)

The inference script handles:
- Loading the Whisper model using the faster-whisper library
- Processing audio data from various input sources (S3, direct input, base64 encoded)
- Optimizing performance for both CPU and GPU environments
- Returning transcription results in a standardized format

#### Dependencies Layer

A Lambda layer containing:
- boto3 (AWS SDK for Python)
- jsonschema (for JSON schema validation)
- protobuf (for Protocol Buffers)
- A custom SageMaker wrapper for simplified SageMaker operations

## Deployment

### Prerequisites

- AWS CLI configured with appropriate permissions
- Amazon SageMaker service quota sufficient for the selected instance type and count
- GPU instance availability in your AWS region (G4dn or G5 instances recommended)

### Deployment Options

The stack can be deployed in two ways:

1. **As part of the main LCA solution**: Set `TranscribeApiMode` to `whisper-on-sagemaker` in the main LCA template.

2. **As a standalone stack**: Deploy directly using the template.yaml file:
   ```
   aws cloudformation deploy \
     --template-file template.yaml \
     --stack-name lca-whisper-sagemaker \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       WhisperModelSize=large-v2 \
       SageMakerInstanceType=ml.g5.2xlarge
   ```

## Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| WhisperModelSize | Size of the Whisper model to deploy | large-v2 |
| SageMakerInstanceType | Instance type for the SageMaker endpoint | ml.g5.2xlarge |
| SageMakerInstanceCount | Number of instances for the endpoint | 1 |
| S3BucketName | S3 bucket for model artifacts (optional) | (creates new bucket) |
| EndpointName | Name for the SageMaker endpoint (optional) | (auto-generated) |
| EnableAutoScaling | Enable/disable autoscaling | true |
| AutoScalingMinCapacity | Minimum instances for autoscaling | 1 |
| AutoScalingMaxCapacity | Maximum instances for autoscaling | 3 |
| AutoScalingTargetGpuUtilization | Target GPU utilization percentage | 50 |
| AutoScalingScaleOutCooldown | Cooldown period after scale-out (seconds) | 60 |
| AutoScalingScaleInCooldown | Cooldown period after scale-in (seconds) | 300 |

## Auto Scaling

When auto scaling is enabled, the SageMaker endpoint will automatically scale based on GPU utilization:

- Scale out: Adds instances when GPU utilization exceeds the target percentage
- Scale in: Removes instances when GPU utilization falls below the target percentage

The auto scaling configuration can be adjusted using the following parameters:
- `EnableAutoScaling`: Set to "true" to enable auto scaling
- `AutoScalingMinCapacity`: Minimum number of instances
- `AutoScalingMaxCapacity`: Maximum number of instances
- `AutoScalingTargetGpuUtilization`: Target GPU utilization percentage
- `AutoScalingScaleOutCooldown`: Cooldown period after scale-out
- `AutoScalingScaleInCooldown`: Cooldown period after scale-in

## Whisper Model Options

The stack supports various Whisper model sizes:

| Model Size | Description | Recommended Instance Type |
|------------|-------------|---------------------------|
| tiny | Smallest model, fastest but less accurate | ml.g4dn.xlarge |
| tiny.en | English-only tiny model | ml.g4dn.xlarge |
| base | Small general model | ml.g4dn.xlarge |
| base.en | English-only base model | ml.g4dn.xlarge |
| small | Medium-sized general model | ml.g4dn.2xlarge |
| small.en | English-only small model | ml.g4dn.2xlarge |
| medium | Large general model | ml.g5.xlarge |
| medium.en | English-only medium model | ml.g5.xlarge |
| large | Very large general model | ml.g5.2xlarge |
| large-v1 | Original large model | ml.g5.2xlarge |
| large-v2 | Improved large model (default) | ml.g5.2xlarge |
| large-v3 | Latest large model | ml.g5.2xlarge |

Larger models provide better accuracy but require more computational resources.

## Performance Considerations

- **Instance Type**: G5 instances are recommended for best performance, especially for larger models.
- **Model Size**: Choose a model size appropriate for your accuracy requirements and available resources.
- **Auto Scaling**: Enable auto scaling for production workloads to handle varying call volumes.
- **Inference Optimization**: The inference script includes optimizations for both CPU and GPU environments.

## Limitations

- Whisper may have different latency characteristics compared to Amazon Transcribe.
- Some Amazon Transcribe features (like custom vocabularies for certain languages) may not be directly supported.
- Requires GPU instances, which may have limited availability in some regions.

## Outputs

The stack provides the following outputs:

- **WhisperSageMakerEndpointName**: Name of the deployed SageMaker endpoint
- **WhisperModelSize**: Size of the deployed Whisper model
- **S3BucketName**: Name of the S3 bucket used for model artifacts
- **AutoScalingEnabled**: Whether auto scaling is enabled
- **AutoScalingMinCapacity**: Minimum number of instances for auto scaling
- **AutoScalingMaxCapacity**: Maximum number of instances for auto scaling
- **AutoScalingTargetGpuUtilization**: Target GPU utilization percentage
- **AutoScalingScaleOutCooldown**: Cooldown period after scale-out
- **AutoScalingScaleInCooldown**: Cooldown period after scale-in

## Cleanup

To delete the stack and all associated resources:

```
aws cloudformation delete-stack --stack-name lca-whisper-sagemaker
```

Note: This will delete the SageMaker endpoint, model, and endpoint configuration. If a new S3 bucket was created, it will also be deleted along with any contents.

## License

This project is licensed under the Apache License 2.0 - see the LICENSE file for details.
