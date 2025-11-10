# LCA Security Update Scripts

## ⚠️ For Existing Deployments Only

**These scripts are designed to update EXISTING LCA deployments that are already running in AWS.** They apply security patches to live ECS containers and EC2 instances.

> **Fresh deployments automatically include all security fixes and don't need these scripts.**

This folder contains scripts to apply security updates to your existing Amazon Transcribe Live Call Analytics (LCA) deployment.

## Scripts Overview

### Main Deployment Scripts

1. **`security-update-deployment.sh`** - Comprehensive security update for both containers and EC2
   - Updates container images with security patches
   - Updates EC2 instances with OS patches
   - Handles both ECS and CloudFormation updates

2. **`minimal-security-update.sh`** - Minimal security update without major version changes
   - Applies only essential security patches
   - Maintains full compatibility with existing code
   - Recommended for production environments

### Troubleshooting Scripts

3. **`fix-dependencies.sh`** - Fixes Node.js dependency conflicts
   - Resolves package-lock.json sync issues
   - Clears npm cache and reinstalls dependencies
   - Run this if you encounter npm build errors

4. **`fix-platform-architecture.sh`** - Fixes Docker platform architecture issues
   - Rebuilds containers for linux/amd64 platform
   - Resolves ECS Fargate "manifest descriptor" errors
   - Ensures containers run properly on AWS

5. **`fix-patch-manager.sh`** - Fixes AWS Patch Manager "RESOURCE_NOT_REPORTING" errors
   - Restarts and updates SSM agent
   - Configures patch group tags
   - Runs initial patch baseline scan
   - Resolves patch compliance reporting issues

### Discovery Scripts

6. **`find-asterisk-instance.sh`** - Locates Asterisk EC2 instances
   - Searches across CloudFormation stacks
   - Finds instances by name tags
   - Provides detailed instance information

7. **`update-ec2-security.sh`** - Updates specific EC2 instances
   - Applies security patches via SSM
   - Can trigger CloudFormation stack updates
   - Monitors update progress

### Verification Scripts

8. **`verify-security-updates.sh`** - Verifies security updates were applied
   - Checks ECS service status
   - Verifies EC2 instance patches
   - Confirms package versions

9. **`verify-patch-management.sh`** - Verifies patch management configuration
   - Checks SSM agent status
   - Verifies patch baselines
   - Confirms maintenance windows

## Usage Examples

### Quick Security Update
```bash
# Apply comprehensive security updates
./security-update-deployment.sh LCA-YOUR-STACK-NAME
```

### Fix Common Issues
```bash
# Fix dependency issues
./fix-dependencies.sh

# Fix platform architecture issues
./fix-platform-architecture.sh LCA-YOUR-STACK-NAME

# Fix patch manager reporting issues
./fix-patch-manager.sh i-1234567890abcdef0
# or
./fix-patch-manager.sh LCA-YOUR-STACK-NAME
```

### Find and Update Specific Components
```bash
# Find Asterisk instance
./find-asterisk-instance.sh LCA-YOUR-MAIN-STACK-NAME

# Update specific EC2 instance
./update-ec2-security.sh LCA-YOUR-NESTED-STACK-NAME
```

### Verify Updates
```bash
# Verify security updates
./verify-security-updates.sh LCA-YOUR-STACK-NAME

# Verify patch management
./verify-patch-management.sh LCA-YOUR-STACK-NAME
```

## Prerequisites

- AWS CLI configured with appropriate permissions
- Docker installed (for container updates)
- Node.js and npm installed (for dependency fixes)
- Access to your LCA CloudFormation stacks

## Required AWS Permissions

Your AWS credentials need the following permissions:
- CloudFormation: `describe-stacks`, `describe-stack-resources`, `update-stack`
- ECS: `describe-services`, `describe-clusters`, `update-service`
- EC2: `describe-instances`, `describe-tags`, `create-tags`
- SSM: `send-command`, `describe-instance-information`, `get-command-invocation`, `describe-patch-baselines`, `describe-instance-patch-states`
- ECR: `get-login-password`, `describe-repositories`

## Security Vulnerabilities Addressed

### Container Images
- **ncurses**: Updated to patched version
- **gnutls**: Updated to patched version  
- **glibc**: Updated to patched version
- **util-linux**: Updated to patched version
- **tar**: Updated to patched version

### EC2 Instances
- **liburiparser1**: Updated to ESM patched version
- **libopusfile0**: Updated to ESM patched version

## Troubleshooting

### Common Issues

1. **"RESOURCE_NOT_REPORTING" error**
   - Run `fix-patch-manager.sh` to resolve patch manager issues
   - This script handles SSM agent problems and initial patch scans

2. **"Platform architecture mismatch" error**
   - Run `fix-platform-architecture.sh` to rebuild for correct platform

3. **npm dependency conflicts**
   - Run `fix-dependencies.sh` to resolve package-lock.json issues

4. **CloudFormation parameter errors**
   - Check if you're using the correct stack name (main vs nested)
   - Use `find-asterisk-instance.sh` to locate the right stack

### Getting Help

If you encounter issues:
1. Check the script output for specific error messages
2. Verify your AWS permissions
3. Ensure you're using the correct stack names
4. Check CloudFormation and ECS consoles for detailed status

## Fresh Deployments vs. Existing Deployments

### 🆕 Fresh Deployments (New LCA Installations)
- **No scripts needed** - Security fixes are built into the CloudFormation templates
- All containers and EC2 instances are created with latest security patches
- Automatic patch management is configured from day one

### 🔄 Existing Deployments (Already Running LCA)
- **Use these scripts** to apply security updates to running systems
- Updates live ECS containers and EC2 instances
- Maintains service availability during updates
- Applies the same security fixes that fresh deployments get automatically

**How to tell which you have:**
- If you deployed LCA before these security fixes were added → Use these scripts
- If you're deploying LCA fresh with the updated templates → No scripts needed

## Script Maintenance

These scripts are designed to work with the current LCA architecture. If AWS services or the LCA solution architecture changes, the scripts may need updates.