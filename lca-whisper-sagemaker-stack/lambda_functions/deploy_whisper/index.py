#!/usr/bin/env python3
import os
import json
import logging
import boto3
import shutil
import time
import traceback

import cfnresponse
from datetime import datetime
from botocore.exceptions import ClientError
# Import our custom sagemaker module from the Lambda layer
import sagemaker
from sagemaker import get_execution_role
from sagemaker import Model
from config import (
    S3_BUCKET, S3_PREFIX, S3_OUTPUT_PATH, INSTANCE_TYPE,
    INSTANCE_COUNT, MODEL_DIR, ENDPOINT_INFO_FILE, WHISPER_MODEL,
    SAGEMAKER_ROLE_ARN
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logging.getLogger().setLevel(logging.INFO)

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

def check_endpoint_exists(endpoint_name):
    """
    Check if a SageMaker endpoint exists.
    
    Args:
        endpoint_name: Name of the endpoint to check
        
    Returns:
        tuple: (exists: bool, status: str or None)
    """
    try:
        sm_client = boto3.client('sagemaker')
        response = sm_client.describe_endpoint(EndpointName=endpoint_name)
        return True, response['EndpointStatus']
    except ClientError as e:
        if e.response['Error']['Code'] == 'ValidationException':
            return False, None
        else:
            # Re-raise other errors
            raise e

def create_sagemaker_model(model):
    """
    Create a SageMaker model using the SageMaker client.
    
    Args:
        model: SageMaker Model object
        
    Returns:
        str: The model name
    """
    try:
        sm_client = boto3.client('sagemaker')
        
        logger.info(f"Creating SageMaker model: {model.name}")
        sm_client.create_model(
            ModelName=model.name,
            PrimaryContainer={
                'Image': model.image_uri,
                'ModelDataUrl': model.model_data,
                'Environment': model.env
            },
            ExecutionRoleArn=model.role
        )
        logger.info(f"Model {model.name} created successfully")
        return model.name
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ValidationException' and 'already exists' in str(e):
            logger.info(f"Model {model.name} already exists, continuing...")
            return model.name
        else:
            logger.error(f"Error creating model: {str(e)}")
            raise e

def deregister_autoscaling_targets(endpoint_name):
    """
    Deregister Application Auto Scaling targets for the endpoint.
    
    Args:
        endpoint_name: Name of the endpoint
        
    Returns:
        list: List of scalable targets that were deregistered
    """
    try:
        autoscaling_client = boto3.client('application-autoscaling')
        
        # Get all scalable targets for this endpoint (search without specifying variant name)
        logger.info(f"Checking for auto scaling targets for endpoint: {endpoint_name}")
        
        # First, try to get all scalable targets for sagemaker namespace
        response = autoscaling_client.describe_scalable_targets(
            ServiceNamespace='sagemaker'
        )
        
        scalable_targets = response.get('ScalableTargets', [])
        
        # Filter for targets that belong to this specific endpoint
        endpoint_targets = []
        for target in scalable_targets:
            resource_id = target['ResourceId']
            # Check if this target belongs to our endpoint
            if resource_id.startswith(f"endpoint/{endpoint_name}/variant/"):
                endpoint_targets.append(target)
                logger.info(f"Found auto scaling target: {resource_id}")
        
        if not endpoint_targets:
            logger.info(f"No auto scaling targets found for endpoint {endpoint_name}")
            return []
        
        # Deregister each scalable target
        deregistered_targets = []
        for target in endpoint_targets:
            logger.info(f"Deregistering scalable target: {target['ResourceId']}")
            autoscaling_client.deregister_scalable_target(
                ServiceNamespace='sagemaker',
                ResourceId=target['ResourceId'],
                ScalableDimension=target['ScalableDimension']
            )
            deregistered_targets.append(target)
        
        logger.info(f"Deregistered {len(deregistered_targets)} auto scaling targets")
        return deregistered_targets
        
    except ClientError as e:
        if e.response['Error']['Code'] == 'ValidationException':
            logger.info("No auto scaling targets to deregister")
            return []
        else:
            logger.error(f"Error deregistering auto scaling targets: {str(e)}")
            raise e


def re_register_autoscaling_targets(endpoint_name, deregistered_targets):
    """
    Re-register Application Auto Scaling targets for the endpoint.
    
    Args:
        endpoint_name: Name of the endpoint
        deregistered_targets: List of previously deregistered targets to restore
    """
    if not deregistered_targets:
        logger.info("No auto scaling targets to re-register")
        return
    
    try:
        autoscaling_client = boto3.client('application-autoscaling')
        
        for target in deregistered_targets:
            logger.info(f"Re-registering scalable target: {target['ResourceId']}")
            
            # Prepare the registration parameters
            register_params = {
                'ServiceNamespace': 'sagemaker',
                'ResourceId': target['ResourceId'],
                'ScalableDimension': target['ScalableDimension'],
                'MinCapacity': target['MinCapacity'],
                'MaxCapacity': target['MaxCapacity']
            }
            
            # Only include RoleArn if it exists in the target (for SageMaker endpoints, 
            # this is often optional as service-linked roles are used automatically)
            if 'RoleArn' in target and target['RoleArn']:
                register_params['RoleArn'] = target['RoleArn']
                logger.info(f"Using existing role: {target['RoleArn']}")
            else:
                logger.info("No RoleArn provided, Application Auto Scaling will use service-linked role")
            
            autoscaling_client.register_scalable_target(**register_params)
        
        logger.info(f"Re-registered {len(deregistered_targets)} auto scaling targets")
        
    except Exception as e:
        logger.error(f"Error re-registering auto scaling targets: {str(e)}")
        # Don't raise here as the endpoint update might have succeeded


def update_endpoint(endpoint_name, model, instance_type, instance_count):
    """
    Update an existing SageMaker endpoint with a new model.
    
    Args:
        endpoint_name: Name of the endpoint to update
        model: SageMaker Model object to deploy
        instance_type: Instance type for the endpoint
        instance_count: Number of instances
        
    Returns:
        bool: True if successful
    """
    deregistered_targets = []
    try:
        sm_client = boto3.client('sagemaker')
        
        # Step 1: Deregister any auto scaling targets
        deregistered_targets = deregister_autoscaling_targets(endpoint_name)
        
        # Step 2: Create the model first
        model_name = create_sagemaker_model(model)
        
        # Step 3: Create a new endpoint configuration
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        new_config_name = f"{endpoint_name}-config-{timestamp}"
        
        logger.info(f"Creating new endpoint configuration: {new_config_name}")
        sm_client.create_endpoint_config(
            EndpointConfigName=new_config_name,
            ProductionVariants=[
                {
                    'VariantName': 'AllTraffic',
                    'ModelName': model_name,
                    'InitialInstanceCount': instance_count,
                    'InstanceType': instance_type,
                    'InitialVariantWeight': 1.0
                }
            ]
        )
        
        # Step 4: Update the endpoint to use the new configuration
        logger.info(f"Updating endpoint {endpoint_name} with new configuration")
        sm_client.update_endpoint(
            EndpointName=endpoint_name,
            EndpointConfigName=new_config_name
        )
        
        # Step 5: Wait for the update to complete
        logger.info("Waiting for endpoint update to complete...")
        waiter = sm_client.get_waiter('endpoint_in_service')
        waiter.wait(
            EndpointName=endpoint_name,
            WaiterConfig={
                'Delay': 30,
                'MaxAttempts': 40  # 20 minutes max
            }
        )
        
        # Step 6: Re-register auto scaling targets if they were deregistered
        re_register_autoscaling_targets(endpoint_name, deregistered_targets)
        
        logger.info(f"Endpoint {endpoint_name} updated successfully")
        return True
        
    except Exception as e:
        logger.error(f"Error updating endpoint: {str(e)}")
        
        # Try to re-register auto scaling targets even if update failed
        if deregistered_targets:
            logger.info("Attempting to re-register auto scaling targets after failure...")
            try:
                re_register_autoscaling_targets(endpoint_name, deregistered_targets)
            except Exception as re_reg_error:
                logger.error(f"Failed to re-register auto scaling targets: {str(re_reg_error)}")
        
        raise e

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
        
        # Check if this is an update and if the endpoint already exists
        request_type = event.get('RequestType', 'Create')
        endpoint_exists = False
        endpoint_status = None
        
        if request_type == 'Update':
            # Use the physical resource ID from the previous deployment if available
            existing_endpoint_name = event.get('PhysicalResourceId')
            if existing_endpoint_name:
                endpoint_name = existing_endpoint_name
                endpoint_exists, endpoint_status = check_endpoint_exists(endpoint_name)
                logger.info(f"Stack update detected. Endpoint {endpoint_name} exists: {endpoint_exists}")
                if endpoint_exists:
                    logger.info(f"Endpoint status: {endpoint_status}")
        
        # Set environment variables for config.py
        os.environ['WHISPER_MODEL'] = whisper_model
        os.environ['S3_BUCKET'] = s3_bucket
        os.environ['S3_PREFIX'] = s3_prefix
        os.environ['INSTANCE_TYPE'] = instance_type
        os.environ['INSTANCE_COUNT'] = str(instance_count)
        os.environ['ENDPOINT_NAME'] = endpoint_name
        os.environ['SAGEMAKER_ROLE_ARN'] = sagemaker_role_arn
        
        # Get project root directory (for future use)
        # project_root = os.path.dirname(os.path.abspath(__file__))
        
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
        model_name = f"whisper-model-{timestamp}"
        logger.info(f"Creating SageMaker model: {model_name}")
        model = Model(
            image_uri=image_uri,
            role=role,
            model_data=s3_path,
            name=model_name,
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
        
        # Deploy or update the endpoint
        if endpoint_exists and endpoint_status in ['InService', 'Updating']:
            logger.info(f"Updating existing endpoint {endpoint_name}")
            update_endpoint(endpoint_name, model, instance_type, instance_count)
        else:
            # Deploy new endpoint
            logger.info(f"Deploying new endpoint {endpoint_name}")
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
        
        logger.info(f"Model deployment/update complete. Endpoint name: {endpoint_name}")
        
        # Return success response with endpoint name
        return {
            'EndpointName': endpoint_name,
            'ModelName': model_name,
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
        
        # Create a more detailed error message for CloudFormation
        error_message = str(e)
        error_type = type(e).__name__
        
        # Truncate very long error messages but keep important details
        if len(error_message) > 1000:
            error_message = error_message[:900] + "... (truncated)"
        
        # Create comprehensive error response
        error_response = {
            "Error": error_message,
            "ErrorType": error_type,
            "RequestType": request_type,
            "Timestamp": datetime.now().isoformat()
        }
        
        # Add context-specific error information
        if request_type in ['Create', 'Update']:
            try:
                endpoint_name = event.get('ResourceProperties', {}).get('EndpointName', 'unknown')
                error_response["EndpointName"] = endpoint_name
                error_response["Message"] = f"Failed to {request_type.lower()} SageMaker endpoint '{endpoint_name}': {error_message}"
            except Exception:
                error_response["Message"] = f"Failed to {request_type.lower()} SageMaker endpoint: {error_message}"
        elif request_type == 'Delete':
            error_response["Message"] = f"Failed to delete SageMaker resources: {error_message}"
        
        # Log the full error response for debugging
        logger.error(f"Sending error response to CloudFormation: {json.dumps(error_response, indent=2)}")
        
        # Send failure response with detailed error information
        cfnresponse.send(
            event,
            context,
            cfnresponse.FAILED,
            error_response,
            physical_resource_id
        )
