#!/bin/bash

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Enable command echo for debugging
set -x

# Don't exit immediately on error to allow for better error reporting
set +e

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq is not installed. Please install it first."
    exit 1
fi

# Get the stack name from command line argument or use default
STACK_NAME=$1
if [ -z "$STACK_NAME" ]; then
    echo "Usage: $0 <stack-name>"
    exit 1
fi

echo "Getting ECS cluster and service information from CloudFormation stack: $STACK_NAME"

# Get the ECS cluster name from CloudFormation
CLUSTER_NAME=$(aws cloudformation describe-stack-resources \
    --stack-name $STACK_NAME \
    --logical-resource-id TranscribingCluster \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

if [ -z "$CLUSTER_NAME" ]; then
    echo "Failed to get ECS cluster name from CloudFormation stack"
    exit 1
fi

echo "Found ECS cluster: $CLUSTER_NAME"

# Get the ECS service name from CloudFormation
SERVICE_NAME=$(aws cloudformation describe-stack-resources \
    --stack-name $STACK_NAME \
    --logical-resource-id TranscriberWebsocketFargateService \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

if [ -z "$SERVICE_NAME" ]; then
    echo "Failed to get ECS service name from CloudFormation stack"
    exit 1
fi

echo "Found ECS service: $SERVICE_NAME"

# Get the ECR repository name from CloudFormation
ECR_REPO=$(aws cloudformation describe-stack-resources \
    --stack-name $STACK_NAME \
    --logical-resource-id TranscriberECRRepository \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

if [ -z "$ECR_REPO" ]; then
    echo "Failed to get ECR repository name from CloudFormation stack"
    exit 1
fi

echo "Found ECR repository: $ECR_REPO"

# Get AWS account ID and region
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
AWS_REGION=$(aws configure get region)

# Check if AWS_REGION is empty and set a default
if [ -z "$AWS_REGION" ]; then
    echo "AWS_REGION is empty, setting default to us-east-1"
    AWS_REGION="us-east-1"
fi

echo "Using AWS Region: $AWS_REGION"

# Get the current task definition
TASK_DEFINITION=$(aws ecs describe-services \
    --cluster $CLUSTER_NAME \
    --services $SERVICE_NAME \
    --query "services[0].taskDefinition" \
    --output text)

echo "Current task definition: $TASK_DEFINITION"

# Get the current task definition JSON
TASK_DEF_JSON=$(aws ecs describe-task-definition \
    --task-definition $TASK_DEFINITION \
    --query "taskDefinition" \
    --output json)

# Generate a timestamp for the new image tag
TIMESTAMP=$(date +%Y%m%d%H%M%S)
NEW_IMAGE_TAG="update-$TIMESTAMP"
ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$NEW_IMAGE_TAG"

echo "Building and pushing new Docker image with tag: $NEW_IMAGE_TAG"

echo "Current directory: $(pwd)"
echo "Listing directories:"
find . -type d -name "source" | sort
find . -type d -name "app" | sort

# Get the source directory - hardcode the path based on project structure
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Script directory: $SCRIPT_DIR"

# Try different paths
echo "Trying different paths to find source directory..."

# Option 1: Direct path
SOURCE_DIR="$SCRIPT_DIR/source/app"
echo "Checking $SOURCE_DIR"
if [ -d "$SOURCE_DIR" ]; then
    echo "Found source directory at $SOURCE_DIR"
else
    echo "$SOURCE_DIR does not exist"
    
    # Option 2: From current directory
    SOURCE_DIR="$(pwd)/source/app"
    echo "Checking $SOURCE_DIR"
    if [ -d "$SOURCE_DIR" ]; then
        echo "Found source directory at $SOURCE_DIR"
    else
        echo "$SOURCE_DIR does not exist"
        
        # Option 3: From parent directory
        SOURCE_DIR="$(dirname "$(pwd)")/lca-websocket-transcriber-stack/source/app"
        echo "Checking $SOURCE_DIR"
        if [ -d "$SOURCE_DIR" ]; then
            echo "Found source directory at $SOURCE_DIR"
        else
            echo "$SOURCE_DIR does not exist"
            
            # Option 4: Hardcoded path based on project structure
            SOURCE_DIR="/home/ec2-user/lca-whisper-albarrju/amazon-transcribe-live-call-analytics/lca-websocket-transcriber-stack/source/app"
            echo "Checking $SOURCE_DIR"
            if [ -d "$SOURCE_DIR" ]; then
                echo "Found source directory at $SOURCE_DIR"
            else
                echo "$SOURCE_DIR does not exist"
                
                echo "ERROR: Could not find source directory containing app code"
                echo "Please run this script from the websocket-transcriber-stack directory or specify the path manually"
                exit 1
            fi
        fi
    fi
fi

echo "Using source directory: $SOURCE_DIR"
echo "Checking if directory exists and is accessible..."
if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: $SOURCE_DIR is not a directory or is not accessible"
    exit 1
fi

echo "Listing source directory contents:"
ls -la "$SOURCE_DIR"

echo "Checking if Dockerfile exists:"
if [ -f "$SOURCE_DIR/Dockerfile" ]; then
    echo "Dockerfile found at $SOURCE_DIR/Dockerfile"
    cat "$SOURCE_DIR/Dockerfile"
else
    echo "ERROR: Dockerfile not found at $SOURCE_DIR/Dockerfile"
    echo "Searching for Dockerfile:"
    find "$SCRIPT_DIR" -name "Dockerfile" | sort
    exit 1
fi

# Run ESLint with --fix option on lca.ts and whisper.ts
echo "Running ESLint to fix any linting issues in lca.ts and whisper.ts..."
if [ -d "$SOURCE_DIR/src" ]; then
    cd "$SOURCE_DIR"
    if command -v npx &> /dev/null; then
        # Fix lca.ts
        if [ -f "src/lca.ts" ]; then
            echo "Running ESLint on src/lca.ts..."
            npx eslint --fix src/lca.ts
            if [ $? -ne 0 ]; then
                echo "WARNING: ESLint reported issues in lca.ts but continuing with build"
            else
                echo "ESLint completed successfully for lca.ts"
            fi
        else
            echo "WARNING: lca.ts not found at $SOURCE_DIR/src/lca.ts, skipping ESLint"
        fi
        
        # Fix whisper.ts
        if [ -f "src/whisper.ts" ]; then
            echo "Running ESLint on src/whisper.ts..."
            npx eslint --fix src/whisper.ts
            if [ $? -ne 0 ]; then
                echo "WARNING: ESLint reported issues in whisper.ts but continuing with build"
            else
                echo "ESLint completed successfully for whisper.ts"
            fi
        else
            echo "WARNING: whisper.ts not found at $SOURCE_DIR/src/whisper.ts, skipping ESLint"
        fi
    else
        echo "WARNING: npx not found, skipping ESLint"
    fi
    cd - > /dev/null
else
    echo "WARNING: src directory not found at $SOURCE_DIR/src, skipping ESLint"
fi

# Login to ECR
echo "Logging in to ECR..."
echo "AWS Region: $AWS_REGION"
echo "AWS Account ID: $AWS_ACCOUNT_ID"
echo "ECR Repository: $ECR_REPO"
echo "ECR URI: $ECR_URI"

# Use explicit region parameter
LOGIN_CMD="aws ecr get-login-password --region $AWS_REGION"
echo "Running login command: $LOGIN_CMD"
$LOGIN_CMD | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

LOGIN_RESULT=$?
if [ $LOGIN_RESULT -ne 0 ]; then
    echo "ERROR: Failed to login to ECR (exit code: $LOGIN_RESULT)"
    echo "Trying alternative login method..."
    
    # Try alternative login method
    aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com"
    
    ALT_LOGIN_RESULT=$?
    if [ $ALT_LOGIN_RESULT -ne 0 ]; then
        echo "ERROR: Alternative login method also failed (exit code: $ALT_LOGIN_RESULT)"
        exit 1
    else
        echo "Alternative login method succeeded"
        AWS_REGION="us-east-1"
        ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:$NEW_IMAGE_TAG"
        echo "Updated ECR URI: $ECR_URI"
    fi
fi

# Build and push the Docker image
echo "Building Docker image..."
docker build -t $ECR_URI "$SOURCE_DIR"
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to build Docker image"
    exit 1
fi

echo "Pushing Docker image to ECR..."
docker push $ECR_URI
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to push Docker image to ECR"
    exit 1
fi

echo "Creating new task definition with updated image..."

# Update the container image in the task definition
NEW_TASK_DEF_JSON=$(echo $TASK_DEF_JSON | jq --arg IMAGE "$ECR_URI" '.containerDefinitions[0].image = $IMAGE')

# Register the new task definition
NEW_TASK_DEF=$(aws ecs register-task-definition \
    --family $(echo $TASK_DEF_JSON | jq -r '.family') \
    --execution-role-arn $(echo $TASK_DEF_JSON | jq -r '.executionRoleArn') \
    --task-role-arn $(echo $TASK_DEF_JSON | jq -r '.taskRoleArn') \
    --network-mode $(echo $TASK_DEF_JSON | jq -r '.networkMode') \
    --container-definitions "$(echo $NEW_TASK_DEF_JSON | jq '.containerDefinitions')" \
    --cpu $(echo $TASK_DEF_JSON | jq -r '.cpu') \
    --memory $(echo $TASK_DEF_JSON | jq -r '.memory') \
    --requires-compatibilities $(echo $TASK_DEF_JSON | jq -r '.requiresCompatibilities[]') \
    --query "taskDefinition.taskDefinitionArn" \
    --output text)

echo "New task definition registered: $NEW_TASK_DEF"

# Update the service to use the new task definition
echo "Updating ECS service to use new task definition..."
aws ecs update-service \
    --cluster $CLUSTER_NAME \
    --service $SERVICE_NAME \
    --task-definition $NEW_TASK_DEF \
    --force-new-deployment

echo "Service update initiated. The new task definition will be deployed shortly."
echo "You can monitor the deployment status with:"
echo "aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --query 'services[0].deployments'"

echo "Done!"
