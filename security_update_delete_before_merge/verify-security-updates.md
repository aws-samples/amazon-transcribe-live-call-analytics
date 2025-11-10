# Verify Security Updates in ECS Containers

This guide walks you through verifying that security patches have been applied to your LCA ECS containers.

## Quick Verification (Recommended)

The easiest way to verify security updates is to check the **ECR Image Scan Results**:

1. Go to [Amazon ECR Console](https://console.aws.amazon.com/ecr)
2. Find your repository (search for your stack name, e.g., `lca-bandytoy-websockettranscriberstack`)
3. Click on **Images** tab
4. Find the image with tag starting with `update-` (your security update)
5. Click on the image digest
6. Check the **Vulnerabilities** tab
7. Verify that vulnerabilities for ncurses, gnutls, libc6, util-linux, and tar are resolved

**If vulnerabilities are resolved in the scan, your security updates are working!**

---

## Detailed Verification (Using ECS Exec)

If you need to verify package versions directly in the running container, follow these steps.

**Note:** ECS Exec requires specific IAM permissions and network configuration. If you encounter timeout issues, use the Quick Verification method above instead.

## Prerequisites

- Access to AWS Console
- Your LCA CloudFormation stack name (e.g., `LCA-bandytoy-WEBSOCKETTRANSCRIBERSTACK-46RBOCMXZDJA`)
- Session Manager plugin installed (for CLI method)

## Step 1: Find Your ECS Cluster from CloudFormation

1. Open the [AWS CloudFormation Console](https://console.aws.amazon.com/cloudformation)
2. Find your LCA WebSocket Transcriber stack (usually named like `LCA-{username}-WEBSOCKETTRANSCRIBERSTACK-*`)
3. Click on the stack name
4. Go to the **Resources** tab
5. Look for a resource with:
   - **Logical ID**: `TranscribingCluster`
   - **Type**: `AWS::ECS::Cluster`
6. Click on the **Physical ID** link - this will take you to the ECS cluster

## Step 2: Navigate to the Running Task

1. In the ECS Cluster page, click on the **Tasks** tab
2. You should see one or more running tasks
3. Click on the **Task ID** of a running task

## Step 3: Enable ECS Exec (One-Time Setup)

If ECS Exec is not already enabled on your service:

1. Go back to the cluster page
2. Click on the **Services** tab
3. Select your service (usually named like `*TranscriberWebsocketFargateService*`)
4. Click **Update service**
5. Expand **Deployment configuration**
6. Check **Enable Execute command**
7. Click **Update**
8. Wait for the service to redeploy (2-3 minutes)

## Step 4: Connect to the Container

### Option A: Using AWS Console (Session Manager)

1. On the Task details page, click the **Exec** tab
2. Select the container (usually `websocketcontainer`)
3. Click **Execute command**
4. This will open a terminal session in your browser

### Option B: Using AWS CLI

```bash
# Get your cluster name and task ID from CloudFormation
STACK_NAME="LCA-bandytoy-WEBSOCKETTRANSCRIBERSTACK-46RBOCMXZDJA"

CLUSTER_NAME=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --logical-resource-id TranscribingCluster \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

TASK_ARN=$(aws ecs list-tasks \
    --cluster "$CLUSTER_NAME" \
    --desired-status RUNNING \
    --query "taskArns[0]" \
    --output text)

# Connect to the container
aws ecs execute-command \
    --cluster "$CLUSTER_NAME" \
    --task "$TASK_ARN" \
    --container websocketcontainer \
    --interactive \
    --command "/bin/bash"
```

## Step 5: Check Package Versions

Once connected to the container, run these commands to verify security patches:

### Check all security-relevant packages:

```bash
dpkg -l | grep -E 'ncurses|gnutls|libc6|util-linux|tar'
```

### Check specific packages individually:

```bash
# Check ncurses packages
dpkg -l | grep ncurses

# Check GnuTLS packages
dpkg -l | grep gnutls

# Check libc6 (glibc)
dpkg -l | grep libc6

# Check util-linux
dpkg -l | grep util-linux

# Check tar
dpkg -l | grep "^ii  tar "
```

## Expected Package Versions

Your container is based on **Debian 12 (Bookworm)** via the `node:20-slim` base image. After security updates, you should see versions equal to or greater than:

| Package | Minimum Secure Version |
|---------|------------------------|
| ncurses-base | 6.4-4 |
| libncurses6 | 6.4-4 |
| libgnutls30 | 3.7.9-2+deb12u3 |
| libc6 | 2.36-9+deb12u8 |
| util-linux | 2.38.1-5+deb12u1 |
| tar | 1.34+dfsg-1.2+deb12u1 |

## Step 6: Verify Updates Were Applied

Compare the installed versions with the expected versions above. The version numbers should be equal to or higher than the minimum secure versions listed.

### Example Output:

```
ii  libc6:amd64      2.36-9+deb12u8    amd64    GNU C Library: Shared libraries
ii  libgnutls30:amd64 3.7.9-2+deb12u3  amd64    GNU TLS library - main runtime library
ii  libncurses6:amd64 6.4-4            amd64    shared libraries for terminal handling
ii  ncurses-base     6.4-4             all      basic terminal type definitions
ii  tar              1.34+dfsg-1.2+deb12u1 amd64 GNU version of the tar archiving utility
ii  util-linux       2.38.1-5+deb12u1  amd64    miscellaneous system utilities
```

## Troubleshooting

### ECS Exec Timeout Issues

If you get "Timed out while opening the session" errors, this is usually due to missing IAM permissions or network configuration. ECS Exec requires:

1. **Task IAM Role** must have SSM permissions
2. **Security Group** must allow outbound traffic to AWS Systems Manager endpoints
3. **VPC** must have either:
   - NAT Gateway for private subnets, OR
   - VPC endpoints for SSM services

**Since ECS Exec can be complex to configure, use the alternative methods below instead.**

### ECS Exec Not Working

If you get an error about ECS Exec not being enabled:

1. Make sure you followed Step 3 to enable it on the service
2. Wait for the service to fully redeploy (check the **Deployments** tab)
3. Make sure you're using a task that was started AFTER enabling ECS Exec

### Session Manager Plugin Required

If using AWS CLI, you need the Session Manager plugin installed:

```bash
# macOS (using Homebrew)
brew install --cask session-manager-plugin

# Or download from:
# https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
```

### Container Not Found

If the container name is different, list all containers in the task:

```bash
aws ecs describe-tasks \
    --cluster "$CLUSTER_NAME" \
    --tasks "$TASK_ARN" \
    --query "tasks[0].containers[*].name"
```

## Alternative Methods (Recommended if ECS Exec Fails)

### Method 1: Check ECR Image Scan Results

The easiest way to verify security updates without ECS Exec:

1. Go to [Amazon ECR Console](https://console.aws.amazon.com/ecr)
2. Find your repository (named like `lca-*-transcriberecrrepository-*`)
3. Click on the repository name
4. Click on the **Images** tab
5. Find the image with tag `update-*` (your latest security update)
6. Click on the image digest
7. Look at the **Vulnerabilities** tab to see scan results

**What to look for:**
- The vulnerabilities for ncurses, gnutls, libc6, util-linux, and tar should be marked as resolved
- Compare with older image tags to see the reduction in vulnerabilities

### Method 2: Check Using Docker Locally

If you have Docker installed locally and AWS credentials configured:

```bash
# Set your stack name
STACK_NAME="LCA-bandytoy-WEBSOCKETTRANSCRIBERSTACK-46RBOCMXZDJA"

# Get the ECR repository URI
REPO_URI=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --logical-resource-id TranscriberECRRepository \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

# Get the full image URI (with latest tag)
IMAGE_URI=$(aws ecr describe-images \
    --repository-name "$REPO_URI" \
    --query "sort_by(imageDetails,& imagePushedAt)[-1].imageTags[0]" \
    --output text)

FULL_IMAGE="${REPO_URI}:${IMAGE_URI}"

# Login to ECR
AWS_REGION="us-east-1"  # Change to your region
aws ecr get-login-password --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "${REPO_URI%%/*}"

# Pull and inspect the image
docker pull "$FULL_IMAGE"

# Check package versions
docker run --rm "$FULL_IMAGE" dpkg -l | grep -E 'ncurses|gnutls|libc6|util-linux|tar'
```

### Method 3: Check Base Image (Quick Verification)

Check the base image that your container is built from:

```bash
# Pull the base image
docker pull public.ecr.aws/docker/library/node:20-slim

# Check package versions
docker run --rm public.ecr.aws/docker/library/node:20-slim dpkg -l | grep -E 'ncurses|gnutls|libc6|util-linux|tar'
```

Note: This shows the base image packages before your Dockerfile's `apt-get upgrade` commands, so versions may be slightly older than what's actually deployed.

### Method 4: Review CloudWatch Logs

Check if the container started successfully after the security update:

1. Go to [CloudWatch Logs Console](https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups)
2. Find the log group for your ECS service (usually `/ecs/lca-*-transcriber*`)
3. Look at recent log streams
4. Verify the application is running without errors

### Method 5: Check Dockerfile Build History

Review what was actually built into the image:

```bash
# Get the image URI from ECR
docker pull "$FULL_IMAGE"

# Check the image history
docker history "$FULL_IMAGE" --no-trunc

# Look for the apt-get upgrade commands in the history
```
