# LCA Security Updates

This directory contains documentation for applying security updates to address vulnerabilities in container images and EC2 instances.

## Quick Start

### New Deployments
✅ **No action required** - Security fixes are automatically included when deploying with the updated CloudFormation templates.

### Existing Deployments
If you have an existing LCA deployment, follow the appropriate guide below to apply security updates.

### 📦 ECS Container Updates
See **[security_update_ecs.md](./security_update_ecs.md)** for instructions on:
- Rebuilding container images with security patches
- Deploying updated images to ECS
- Verifying the updates

### 🖥️ EC2 Instance Updates  
See **[security_update_ec2.md](./security_update_ec2.md)** for instructions on:
- Updating the Asterisk server packages
- Enabling Ubuntu Pro for ESM updates
- Using AWS Systems Manager for automated patching

### ✅ Verification
See **[verify-security-updates.md](./verify-security-updates.md)** for instructions on:
- Checking ECR image scan results
- Verifying package versions in running containers
- Confirming EC2 instance patches

## What Gets Updated

### Container Images (ECS)
- **ncurses** - Terminal handling library
- **gnutls** - TLS/SSL library
- **glibc** - GNU C Library
- **util-linux** - System utilities
- **tar** - Archive utility

### EC2 Instances (Asterisk Server)
- **liburiparser1** - URI parsing library
- **libopusfile0** - Opus audio file library

## Quick Start

### Update ECS Containers

```bash
# Navigate to the websocket transcriber stack
cd lca-websocket-transcriber-stack

# Run the update script (builds and deploys new images)
./update-ecs.sh <your-stack-name>
```

### Update EC2 Instance

```bash
# Option 1: Update via CloudFormation (recommended)
aws cloudformation update-stack \
  --stack-name <your-asterisk-stack-name> \
  --use-previous-template \
  --capabilities CAPABILITY_IAM

# Option 2: Manual update via SSM
# See security_update_ec2.md for detailed instructions
```

## Documentation Files

- **[CHANGES_SUMMARY.md](./CHANGES_SUMMARY.md)** - Complete list of changes and affected files
- **[security_update_ecs.md](./security_update_ecs.md)** - Guide for updating ECS containers
- **[security_update_ec2.md](./security_update_ec2.md)** - Guide for updating EC2 instances
- **[verify-security-updates.md](./verify-security-updates.md)** - Verification procedures
- **[CLEANUP_GUIDE.md](./CLEANUP_GUIDE.md)** - Instructions for preparing the pull request

## Support

If you encounter issues:
1. Check the relevant documentation file (ECS or EC2)
2. Review CloudWatch logs for error messages
3. Verify AWS permissions are correct
4. Check CloudFormation stack events for details

## Security Best Practices

1. **Enable automated scanning** - ECR automatically scans images for vulnerabilities
2. **Use Systems Manager Patch Manager** - Automate EC2 patching
3. **Monitor Security Hub** - Track security findings across your deployment
4. **Test in non-production first** - Always test updates before applying to production
5. **Keep backups** - Ensure you can rollback if needed
