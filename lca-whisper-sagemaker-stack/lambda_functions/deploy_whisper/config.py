"""
Configuration settings for the Whisper SageMaker endpoint.
"""
import os

# Model settings
MODEL_DIR = '/tmp/model'  # Using a temporary directory for the model

# Get Whisper model from environment variable or use default
WHISPER_MODEL = os.environ.get('WHISPER_MODEL', 'large-v2')

# SageMaker deployment settings
S3_BUCKET = os.environ.get('S3_BUCKET', '')
S3_PREFIX = os.environ.get('S3_PREFIX', 'whisper')
S3_OUTPUT_PATH = f's3://{S3_BUCKET}/{S3_PREFIX}/output'
INSTANCE_TYPE = os.environ.get('INSTANCE_TYPE', 'ml.g5.2xlarge')
INSTANCE_COUNT = int(os.environ.get('INSTANCE_COUNT', '1'))

# Endpoint name
ENDPOINT_NAME = os.environ.get('ENDPOINT_NAME', f'whisper-endpoint-{WHISPER_MODEL}')

# SageMaker role ARN
SAGEMAKER_ROLE_ARN = os.environ.get('SAGEMAKER_ROLE_ARN', '')

# File to store the endpoint info
ENDPOINT_INFO_FILE = '/tmp/endpoint_info.json'
