#!/bin/bash

##############################################################################################
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
##############################################################################################

##############################################################################################
# Create new Cfn artifacts bucket if not already existing, and publish template and artifacts
# usage: ./publish.sh <cfn_bucket> <cfn_prefix> <region> [public]
##############################################################################################
# Stop the publish process on failures
set -e

# use current directory name as template name
NAME=$(basename `pwd`)

USAGE="$0 <cfn_bucket> <cfn_prefix> <region> [public]"

BUCKET=$1
[ -z "$BUCKET" ] && echo "Cfn bucket name is required parameter. Usage $USAGE" && exit 1

PREFIX=$2
[ -z "$PREFIX" ] && echo "Prefix is required parameter. Usage $USAGE" && exit 1

# Remove trailing slash from prefix if needed
[[ "${PREFIX}" == */ ]] && PREFIX="${PREFIX%?}"

REGION=$3
[ -z "$REGION" ] && echo "Region is a required parameter. Usage $USAGE" && exit 1
export AWS_DEFAULT_REGION=$REGION

ACL=$4
if [ "$ACL" == "public" ]; then
  echo "Published S3 artifacts will be acessible by public (read-only)"
  PUBLIC=true
else
  echo "Published S3 artifacts will NOT be acessible by public."
  PUBLIC=false
fi

# Create bucket if it doesn't already exist
if [ -x $(aws s3api list-buckets --query 'Buckets[].Name' | grep "\"$BUCKET\"") ]; then
  echo "Creating s3 bucket: $BUCKET"
  aws s3 mb s3://${BUCKET} || exit 1
  aws s3api put-bucket-versioning --bucket ${BUCKET} --versioning-configuration Status=Enabled || exit 1
else
  echo "Using existing bucket: $BUCKET"
fi

echo -n "Make temp dir: "
timestamp=$(date "+%Y%m%d_%H%M")
tmpdir=/tmp/$NAME
[ -d $tmpdir ] && rm -fr $tmpdir
mkdir -p $tmpdir

template=template.yaml
s3_template="s3://${BUCKET}/${PREFIX}/${NAME}/template.yaml"
https_template="https://s3.${REGION}.amazonaws.com/${BUCKET}/${PREFIX}/${NAME}/template.yaml"

echo "Creating Lambda layer for dependencies"
# Create directories for the Lambda layer
layer_dir=lambda_layers/dependencies
layer_tmp_dir=${tmpdir}/${layer_dir}
python_dir=${layer_tmp_dir}/python
mkdir -p ${python_dir}

# Create a custom version of the requirements.txt without numpy and pandas
echo "Creating custom requirements without numpy and pandas"
cat > ${tmpdir}/requirements_custom.txt << EOF
boto3>=1.28.0
jsonschema==4.17.3
cfnresponse
EOF

# Install dependencies without numpy and pandas
echo "Installing dependencies without numpy and pandas"
pip install -r ${tmpdir}/requirements_custom.txt -t ${python_dir} --no-cache-dir

# Create a simple wrapper for sagemaker functionality using boto3
echo "Creating boto3 wrapper for sagemaker functionality"
mkdir -p ${python_dir}/sagemaker
cat > ${python_dir}/sagemaker/__init__.py << EOF
"""
Minimal sagemaker module that provides just enough functionality for the Lambda function.
"""
import boto3
import json
import logging
import os
import time

class Session:
    def __init__(self):
        self.boto_session = boto3.Session()
        self.boto_client = boto3.client('sagemaker')
        self.s3_client = boto3.client('s3')
        self.region_name = self.boto_session.region_name
        
    def upload_data(self, path, bucket, key_prefix):
        """Upload data to S3 bucket with the given key prefix."""
        key = f"{key_prefix}/{os.path.basename(path)}"
        self.s3_client.upload_file(path, bucket, key)
        return f"s3://{bucket}/{key}"
        
    @property
    def boto_region_name(self):
        return self.region_name

class Model:
    def __init__(self, image_uri, role, model_data, name, env=None):
        self.image_uri = image_uri
        self.role = role
        self.model_data = model_data
        self.name = name
        self.env = env or {}
        self.sagemaker_client = boto3.client('sagemaker')
        
    def deploy(self, endpoint_name, initial_instance_count, instance_type, wait=True, 
               model_server_workers=1, container_startup_health_check_timeout=60, endpoint_config_kwargs=None):
        """Deploy the model to a SageMaker endpoint."""
        # Create model
        logging.info(f"Creating model {self.name}")
        self.sagemaker_client.create_model(
            ModelName=self.name,
            PrimaryContainer={
                'Image': self.image_uri,
                'ModelDataUrl': self.model_data,
                'Environment': self.env
            },
            ExecutionRoleArn=self.role
        )
        
        # Create endpoint config
        logging.info(f"Creating endpoint config {endpoint_name}")
        endpoint_config_args = {
            'EndpointConfigName': endpoint_name,
            'ProductionVariants': [
                {
                    'VariantName': 'AllTraffic',
                    'ModelName': self.name,
                    'InitialInstanceCount': initial_instance_count,
                    'InstanceType': instance_type,
                    'ContainerStartupHealthCheckTimeoutInSeconds': container_startup_health_check_timeout
                }
            ]
        }
        
        # Handle DataCaptureConfig specially
        if endpoint_config_kwargs and 'DataCaptureConfig' in endpoint_config_kwargs:
            data_capture_config = endpoint_config_kwargs.get('DataCaptureConfig', {})
            enable_capture = data_capture_config.get('EnableCapture', False)
            
            if enable_capture:
                # If data capture is enabled, we need to provide all required parameters
                endpoint_config_args['DataCaptureConfig'] = {
                    'EnableCapture': True,
                    'InitialSamplingPercentage': data_capture_config.get('InitialSamplingPercentage', 100),
                    'DestinationS3Uri': data_capture_config.get('DestinationS3Uri', f's3://{os.environ.get("S3_BUCKET", "")}/datacapture'),
                    'CaptureOptions': data_capture_config.get('CaptureOptions', [{'CaptureMode': 'Input'}, {'CaptureMode': 'Output'}])
                }
            # If data capture is disabled, don't include DataCaptureConfig at all
                
        self.sagemaker_client.create_endpoint_config(**endpoint_config_args)
        
        # Create endpoint
        logging.info(f"Creating endpoint {endpoint_name}")
        self.sagemaker_client.create_endpoint(
            EndpointName=endpoint_name,
            EndpointConfigName=endpoint_name
        )
        
        if wait:
            logging.info(f"Waiting for endpoint {endpoint_name} to be in service")
            waiter = self.sagemaker_client.get_waiter('endpoint_in_service')
            waiter.wait(EndpointName=endpoint_name)
            logging.info(f"Endpoint {endpoint_name} is now in service")
            
        return endpoint_name

def get_execution_role():
    """Get the execution role for SageMaker."""
    # In Lambda, we'll use the role ARN from the environment variable
    return os.environ.get('SAGEMAKER_ROLE_ARN', '')
EOF

# Copy the cfnresponse.py file to the Lambda layer
echo "Copying cfnresponse.py to Lambda layer"
cp lambda_functions/deploy_whisper/cfnresponse.py ${python_dir}/

# Create a zip file of the Lambda layer
echo "Creating Lambda layer zip file"
cd ${tmpdir}/${layer_dir}
zip -r dependencies_lambda_layer.zip python
cd -
mv ${tmpdir}/${layer_dir}/dependencies_lambda_layer.zip ${layer_dir}/

# Ensure all dependencies are properly installed
echo "Verifying dependencies..."
cd ${python_dir}
python -c "import boto3; import jsonschema; import cfnresponse; import sagemaker; print('Dependencies verified successfully')"
cd -

echo "Preparing Lambda function without dependencies"
# Create a temporary directory for the Lambda function
lambda_dir=lambda_functions/deploy_whisper
lambda_tmp_dir=${tmpdir}/${lambda_dir}
mkdir -p ${lambda_tmp_dir}

# Copy Lambda function code to the temporary directory (excluding dependencies)
cp -r ${lambda_dir}/*.py ${lambda_tmp_dir}/
cp -r ${lambda_dir}/model ${lambda_tmp_dir}/

# Update the template to use the temporary directories
sed -e "s|CodeUri: ${lambda_dir}/|CodeUri: ${tmpdir}/${lambda_dir}/|g" \
    -e "s|ContentUri: ${layer_dir}/|ContentUri: ${tmpdir}/${layer_dir}/|g" \
    ${template} > ${tmpdir}/${template}.tmp
mv ${tmpdir}/${template}.tmp ${tmpdir}/${template}

echo "PACKAGING $NAME"
aws cloudformation package \
--template-file ${tmpdir}/${template} \
--output-template-file ${tmpdir}/${template}.packaged \
--s3-bucket $BUCKET --s3-prefix ${PREFIX}/${NAME} \
--region ${REGION} || exit 1

# Move the packaged template back
mv ${tmpdir}/${template}.packaged ${tmpdir}/${template}
echo "Uploading template file to: ${s3_template}"
aws s3 cp ${tmpdir}/${template} ${s3_template}

# Clean up
echo "Cleaning up temporary files"
rm -rf ${lambda_tmp_dir}
rm -rf ${layer_tmp_dir}
echo "Validating template"
aws cloudformation validate-template --template-url ${https_template} > /dev/null || exit 1
echo "Validated: ${https_template}"

if $PUBLIC; then
  echo "Setting public read ACLs on published artifacts"
  files=$(aws s3api list-objects --bucket ${BUCKET} --prefix ${PREFIX} --query "(Contents)[].[Key]" --output text)
  for file in $files
    do
    aws s3api put-object-acl --acl public-read --bucket ${BUCKET} --key $file
    done
fi

echo Published $NAME - Template URL: $https_template
exit 0
