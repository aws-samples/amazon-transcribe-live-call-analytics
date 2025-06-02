#!/usr/bin/env python3
import os
import json
import logging
import boto3
import shutil
import time
import traceback
import urllib.request
import cfnresponse
from datetime import datetime
# Import our custom sagemaker module from the Lambda layer
import sagemaker
from sagemaker import get_execution_role
from sagemaker import Model
from config import (
    S3_BUCKET, S3_PREFIX, S3_OUTPUT_PATH, INSTANCE_TYPE, 
    INSTANCE_COUNT, MODEL_DIR, ENDPOINT_INFO_FILE, WHISPER_MODEL,
    SAGEMAKER_ROLE_ARN
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def download_model_files():
    """
    Download and prepare the model files needed for inference
    """
    # Create model directory if it doesn't exist
    if not os.path.exists(MODEL_DIR):
        os.makedirs(MODEL_DIR)
    
    # Copy inference.py to model directory
    shutil.copy('model/inference.py', f'{MODEL_DIR}/inference.py')
    
    # Create requirements.txt in model directory
    with open(f'{MODEL_DIR}/requirements.txt', 'w') as f:
        f.write("""# Using faster-whisper directly instead of whisperx
faster-whisper==0.7.1
# Use standard PyTorch version and let SageMaker handle CUDA compatibility
torch==2.0.0
torchaudio==2.0.0
numpy>=1.24.0
boto3>=1.28.0
imageio-ffmpeg>=0.6.0
ffmpeg-python>=0.2.0
ctranslate2==3.17.1
""")
    
    # Create config.py in model directory
    with open(f'{MODEL_DIR}/config.py', 'w') as f:
        f.write(f"""import os
import sys

\"\"\"
This file is used as a fallback if the environment variable approach doesn't work.
It imports the WHISPER_MODEL from the root config.py file.
\"\"\"

# Add the parent directory to the path so we can import from the root config
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

try:
    # Try to import from the root config
    from config import WHISPER_MODEL
except ImportError:
    # If that fails, use a default value
    print("Failed to import from config.py, using default value.")
    WHISPER_MODEL = "{WHISPER_MODEL}"
""")
    
    logger.info(f"Model files prepared in {MODEL_DIR}")
    return True

def deploy_model(event, context):
    """
    Deploy the Whisper model to SageMaker.
    
    Args:
        event: CloudFormation custom resource event
        context: Lambda context
        
    Returns:
        dict: Response data including the endpoint name
    """
    try:
        # Get parameters from the event
        whisper_model = event.get('ResourceProperties', {}).get('WhisperModel', WHISPER_MODEL)
        s3_bucket = event.get('ResourceProperties', {}).get('S3Bucket', S3_BUCKET)
        s3_prefix = event.get('ResourceProperties', {}).get('S3Prefix', S3_PREFIX)
        instance_type = event.get('ResourceProperties', {}).get('InstanceType', INSTANCE_TYPE)
        instance_count = int(event.get('ResourceProperties', {}).get('InstanceCount', INSTANCE_COUNT))
        endpoint_name = event.get('ResourceProperties', {}).get('EndpointName', f"whisper-endpoint-{datetime.now().strftime('%Y%m%d%H%M%S')}")
        sagemaker_role_arn = event.get('ResourceProperties', {}).get('SageMakerRoleArn', SAGEMAKER_ROLE_ARN)
        
        # Set environment variables for config.py
        os.environ['WHISPER_MODEL'] = whisper_model
        os.environ['S3_BUCKET'] = s3_bucket
        os.environ['S3_PREFIX'] = s3_prefix
        os.environ['INSTANCE_TYPE'] = instance_type
        os.environ['INSTANCE_COUNT'] = str(instance_count)
        os.environ['ENDPOINT_NAME'] = endpoint_name
        os.environ['SAGEMAKER_ROLE_ARN'] = sagemaker_role_arn
        
        # Get project root directory
        project_root = os.path.dirname(os.path.abspath(__file__))
        
        # Download and prepare model files
        download_model_files()
        
        # Create model archive name with timestamp
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        model_archive_name = f'model_{timestamp}'
        model_archive_path = os.path.join('/tmp', f'{model_archive_name}.tar.gz')
        
        # Check if model directory exists
        if not os.path.exists(MODEL_DIR):
            logger.error(f"Model directory {MODEL_DIR} does not exist.")
            raise FileNotFoundError(f"Model directory {MODEL_DIR} not found")
        
        logger.info(f"Creating model archive from {MODEL_DIR}")
        # Create tar.gz of the model
        shutil.make_archive(
            os.path.join('/tmp', model_archive_name),
            'gztar',
            MODEL_DIR
        )
        logger.info(f"Model archive created at {model_archive_path}")
        
        # Initialize SageMaker session
        logger.info("Initializing SageMaker session")
        sagemaker_session = sagemaker.Session()
        
        # Upload model to S3
        logger.info(f"Uploading model to S3 bucket {s3_bucket} with prefix {s3_prefix}")
        s3_path = sagemaker_session.upload_data(
            model_archive_path,
            bucket=s3_bucket,
            key_prefix=s3_prefix
        )
        logger.info(f"Model uploaded to {s3_path}")
        
        # Get role and image URI
        role = sagemaker_role_arn if sagemaker_role_arn else get_execution_role()
        region = sagemaker_session.boto_region_name
        # Use PyTorch 2.1.0 with CUDA 11.8 for optimal performance
        image_uri = f"763104351884.dkr.ecr.{region}.amazonaws.com/pytorch-inference:2.1.0-gpu-py310-cu118-ubuntu20.04-sagemaker"
        logger.info(f"Using image URI: {image_uri}")
        logger.info(f"Using IAM role: {role}")
        
        # Create model with optimized settings
        logger.info("Creating SageMaker model")
        model = Model(
            image_uri=image_uri,
            role=role,
            model_data=s3_path,
            name=f"whisper-model-{timestamp}",
            env={
                'SAGEMAKER_CONTAINER_LOG_LEVEL': '20',  # INFO level logging
                'SAGEMAKER_PROGRAM': 'inference.py',
                'SAGEMAKER_SUBMIT_DIRECTORY': '/opt/ml/model',
                'SAGEMAKER_REGION': region,
                'SAGEMAKER_CONTAINER_INSTALL_FFMPEG': '1',  # Flag to install ffmpeg
                'SAGEMAKER_INSTALL_SYSTEM_PACKAGES': '1',
                'SAGEMAKER_INSTALL_REQUIREMENTS': '1',  # Flag to install requirements.txt
                'SAGEMAKER_REQUIREMENTS_FILE': '/opt/ml/model/requirements.txt',  # Specify the requirements file path
                'WHISPER_MODEL': whisper_model,  # Pass the Whisper model as an environment variable
                'OMP_NUM_THREADS': '4',  # Optimize OpenMP threading
                'MKL_NUM_THREADS': '4',  # Optimize Intel MKL threading
                'PYTORCH_CUDA_ALLOC_CONF': 'max_split_size_mb:128',  # Optimize CUDA memory allocation
                'TORCH_CUDNN_V8_API_ENABLED': '1',  # Enable cuDNN v8 API for better performance
                'TORCH_USE_RTLD_GLOBAL': '1',  # Improve dynamic library loading
                'TORCH_COMPILE': '1'  # Enable torch.compile for faster inference
            }
        )
        
        # Deploy model with optimized configuration
        logger.info(f"Deploying model to endpoint {endpoint_name}")
        logger.info(f"Instance type: {instance_type}, Instance count: {instance_count}")
        
        try:
            # Set a timeout for the deployment
            timeout = 1800  # 30 minutes
            start_time = time.time()
            
            # Start the deployment
            logger.info("Starting model deployment...")
            
            # Configure model server settings for better performance
            model_server_workers = max(1, int(os.environ.get('MODEL_SERVER_WORKERS', '1')))
            
            logger.info("This may take 10-15 minutes to complete...")
            # Deploy without DataCaptureConfig since it's disabled
            predictor = model.deploy(
                endpoint_name=endpoint_name,
                initial_instance_count=instance_count,
                instance_type=instance_type,
                wait=True,  # Wait for deployment to complete
                model_server_workers=model_server_workers,  # Set number of model server workers
                container_startup_health_check_timeout=600  # Increase health check timeout
            )
            
            # Deployment completed successfully
            elapsed_time = time.time() - start_time
            logger.info(f"Deployment completed successfully in {elapsed_time:.2f} seconds")
                
        except Exception as deploy_error:
            # Log the full exception details
            logger.error("Deployment error details:")
            logger.error(traceback.format_exc())
            
            # Check if the endpoint was created despite the error
            try:
                sm_client = boto3.client('sagemaker')
                response = sm_client.describe_endpoint(EndpointName=endpoint_name)
                status = response['EndpointStatus']
                logger.info(f"Despite the error, endpoint exists with status: {status}")
                logger.info("You can check the endpoint status in the AWS SageMaker console")
            except Exception:
                logger.error(f"Could not find endpoint {endpoint_name} - it may not have been created")
                
            # Re-raise the original error
            raise deploy_error
        
        # Save endpoint information to a file
        endpoint_info = {
            "endpoint_name": endpoint_name,
            "created_at": datetime.now().isoformat(),
            "s3_model_path": s3_path,
            "s3_output_path": S3_OUTPUT_PATH
        }
        
        with open(ENDPOINT_INFO_FILE, 'w') as f:
            json.dump(endpoint_info, f, indent=2)
        
        logger.info(f"Endpoint information saved to {ENDPOINT_INFO_FILE}")
        
        # Clean up the model archive
        os.remove(model_archive_path)
        logger.info(f"Removed temporary model archive {model_archive_path}")
        
        logger.info(f"Model deployment complete. Endpoint name: {endpoint_name}")
        
        # Return success response with endpoint name
        return {
            'EndpointName': endpoint_name,
            'ModelName': f"whisper-model-{timestamp}",
            'S3ModelPath': s3_path
        }
        
    except Exception as e:
        logger.error(f"Error deploying model: {str(e)}")
        logger.error(traceback.format_exc())
        raise

def delete_model(event, context):
    """
    Delete the SageMaker endpoint, endpoint config, and model.
    
    Args:
        event: CloudFormation custom resource event
        context: Lambda context
        
    Returns:
        dict: Response data including deletion status
    """
    # Get endpoint name from the event
    endpoint_name = event.get('PhysicalResourceId')
    if not endpoint_name:
        logger.info("No endpoint name provided, nothing to delete")
        return {"Status": "SUCCESS", "Message": "No endpoint name provided, nothing to delete"}
    
    # Initialize SageMaker client
    sm_client = boto3.client('sagemaker')
    
    # Track deletion status
    deletion_errors = []
    
    # Delete endpoint
    try:
        logger.info(f"Deleting endpoint {endpoint_name}")
        sm_client.delete_endpoint(EndpointName=endpoint_name)
        logger.info(f"Endpoint {endpoint_name} deleted")
    except Exception as e:
        error_msg = f"Error deleting endpoint {endpoint_name}: {str(e)}"
        logger.error(error_msg)
        deletion_errors.append(error_msg)
    
    # Delete endpoint config
    try:
        logger.info(f"Deleting endpoint config {endpoint_name}")
        sm_client.delete_endpoint_config(EndpointConfigName=endpoint_name)
        logger.info(f"Endpoint config {endpoint_name} deleted")
    except Exception as e:
        error_msg = f"Error deleting endpoint config {endpoint_name}: {str(e)}"
        logger.error(error_msg)
        deletion_errors.append(error_msg)
    
    # Delete model
    try:
        # Model name is usually the same as endpoint name, but could be different
        # If we had stored the model name, we could use that instead
        model_name = f"whisper-model-{endpoint_name.split('-')[-1]}"
        logger.info(f"Deleting model {model_name}")
        sm_client.delete_model(ModelName=model_name)
        logger.info(f"Model {model_name} deleted")
    except Exception as e:
        error_msg = f"Error deleting model: {str(e)}"
        logger.error(error_msg)
        deletion_errors.append(error_msg)
    
    # Even if there are errors, we want to tell CloudFormation that the deletion was successful
    # This prevents the stack from getting stuck in DELETE_IN_PROGRESS state
    if deletion_errors:
        logger.warning("Deletion completed with errors, but reporting success to CloudFormation to prevent stack from getting stuck")
        return {
            "Status": "SUCCESS",
            "Message": "Deletion completed with errors, but reporting success to CloudFormation",
            "Errors": deletion_errors
        }
    else:
        return {
            "Status": "SUCCESS",
            "Message": "All resources deleted successfully"
        }

def handler(event, context):
    """
    Lambda handler for the CloudFormation custom resource.
    
    Args:
        event: CloudFormation custom resource event
        context: Lambda context
    """
    logger.info(f"Received event: {json.dumps(event)}")
    
    # Extract request type
    request_type = event['RequestType']
    
    # Initialize response data
    response_data = {}
    physical_resource_id = event.get('PhysicalResourceId', '')
    
    try:
        if request_type == 'Create' or request_type == 'Update':
            # Deploy or update the model
            response_data = deploy_model(event, context)
            physical_resource_id = response_data['EndpointName']
        elif request_type == 'Delete':
            # Delete the model
            delete_model(event, context)
        
        # Send success response
        cfnresponse.send(
            event,
            context,
            cfnresponse.SUCCESS,
            response_data,
            physical_resource_id
        )
    except Exception as e:
        logger.error(f"Error handling {request_type} request: {str(e)}")
        logger.error(traceback.format_exc())
        
        # Send failure response
        cfnresponse.send(
            event,
            context,
            cfnresponse.FAILED,
            {"Error": str(e)},
            physical_resource_id
        )
