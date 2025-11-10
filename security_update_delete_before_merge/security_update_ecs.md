## Prerequisites

- Access to AWS Console
- Your LCA CloudFormation WEBSOCKETTRANSCRIBERSTACK stack (e.g., `LCA-johnsmith-WEBSOCKETTRANSCRIBERSTACK-XXXXXXXXXX`)

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
5. Under **Deployment configuration** expand **Troubleshooting configuration - recommended**
6. Check **Turn on ECS Exec**
7. Click **Update**
8. Wait for the service to redeploy (2-3 minutes)

## Step 4: Connect to the Container

### Option A: Using AWS Console (Session Manager)

1. Navigate to the task in the Tasks page
2. Under the **configuration tab** there is a **containers** section
3. Select the container (usually `websocketcontainer`)
4. Click **Connect** in the top right corner of this section
5. This will open a terminal session in your browser; Run the command that pops up.

### Option B: Using AWS CLI

```bash
# Get your cluster name and task ID from CloudFormation
STACK_NAME="LCA-johnsmith-WEBSOCKETTRANSCRIBERSTACK-46RBOCMXZDJA"

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