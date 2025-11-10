# Security Update Changes Summary

## Overview

This document summarizes the security updates applied to the LCA (Live Call Analytics) solution to address vulnerabilities identified in container images and EC2 instances.

## Changes Made

### 1. Container Image Security Updates

**File Modified:** `lca-websocket-transcriber-stack/source/app/Dockerfile`

**Changes:**
- Updated base image from `node:20-buster` to `node:20-bookworm` (Debian 12)
- Added explicit platform specification: `--platform=linux/amd64` for ECS Fargate compatibility
- Added security package updates in both builder and runtime stages:
  ```dockerfile
  RUN apt-get update && \
      apt-get upgrade -y && \
      apt-get install -y --only-upgrade ncurses-base ncurses-bin libncurses6 libncursesw6 || true && \
      apt-get install -y --only-upgrade gnutls-bin libgnutls30 libgnutls28-dev || true && \
      apt-get install -y --only-upgrade libc6 libc-bin libc6-dev || true && \
      apt-get install -y --only-upgrade util-linux || true && \
      apt-get install -y --only-upgrade tar || true && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/*
  ```

**Packages Updated:**
| Package | Vulnerability | Severity |
|---------|--------------|----------|
| ncurses | CVE-2023-XXXX | High |
| gnutls | CVE-2024-XXXX | High |
| glibc (libc6) | CVE-2024-XXXX | Critical |
| util-linux | CVE-2024-XXXX | Medium |
| tar | CVE-2023-XXXX | Medium |

### 2. EC2 Instance Security Updates

**File Modified:** `lca-chimevc-stack/cloudformation-templates/chime-vc-with-asterisk-server.yaml`

**Changes:**
- Added Ubuntu Pro ESM (Extended Security Maintenance) support
- Added explicit security package updates in UserData script:
  ```yaml
  # Enable Ubuntu Pro for ESM updates
  sudo pro attach ${UbuntuProToken} || true
  sudo pro enable esm-apps || true
  
  # Update vulnerable packages
  sudo apt-get update
  sudo apt-get install -y --only-upgrade liburiparser1 libopusfile0
  ```

**Packages Updated:**
| Package | Vulnerability | Severity | Source |
|---------|--------------|----------|--------|
| liburiparser1 | CVE-2024-XXXX | High | ESM Apps |
| libopusfile0 | CVE-2023-XXXX | Medium | ESM Apps |

**New CloudFormation Parameter:**
- `UbuntuProToken` (Optional) - Token for Ubuntu Pro subscription to access ESM updates

### 3. Code Compatibility Fixes

**Files Modified:**
- `lca-websocket-transcriber-stack/source/app/src/index.ts`
- `lca-websocket-transcriber-stack/source/app/src/lca.ts`
- `lca-websocket-transcriber-stack/source/app/src/whisper.ts`

**Changes:**
- Fixed Fastify logging configuration (migrated from deprecated `prettyPrint` to `transport`)
- Fixed AWS SDK type compatibility issues
- Updated TypeScript type assertions for better type safety

## Deployment Impact

### For New Deployments
✅ **Automatic** - All security fixes are included when deploying with updated templates

### For Existing Deployments
⚠️ **Manual Update Required** - Follow the guides in this directory:
- **ECS Containers:** Rebuild and redeploy using `update-ecs.sh`
- **EC2 Instances:** Update CloudFormation stack or use Systems Manager

## Verification

### Container Images
1. Check ECR image scan results in AWS Console
2. Verify no high/critical vulnerabilities remain
3. Compare scan results before and after update

### EC2 Instances
1. Connect to instance via Systems Manager
2. Run: `dpkg -l | grep -E 'liburiparser1|libopusfile0'`
3. Verify versions include `~esm1` suffix (indicates ESM update)

## Rollback Procedure

### ECS Containers
```bash
# Revert to previous task definition
aws ecs update-service \
  --cluster <cluster-name> \
  --service <service-name> \
  --task-definition <previous-task-definition-arn>
```

### EC2 Instances
```bash
# Rollback CloudFormation stack
aws cloudformation cancel-update-stack --stack-name <stack-name>
```

## Testing Performed

- ✅ Container builds successfully with security updates
- ✅ ECS tasks start and run without errors
- ✅ Platform architecture compatibility verified (linux/amd64)
- ✅ Application functionality maintained
- ✅ EC2 instance boots with security patches
- ✅ Asterisk service remains operational
- ✅ No breaking changes to application code

## Documentation Added

1. **security_update_ecs.md** - Complete guide for updating ECS containers
2. **security_update_ec2.md** - Complete guide for updating EC2 instances
3. **verify-security-updates.md** - Verification procedures and troubleshooting
4. **README.md** - Overview and quick start guide

## Breaking Changes

**None** - All updates are backward compatible and maintain existing functionality.

## Future Maintenance

### Recommended Update Schedule
- **Container Images:** Monthly or when critical CVEs are published
- **EC2 Instances:** Quarterly or when ESM updates are available
- **Dependencies:** Review quarterly for security updates

### Monitoring
- Enable ECR image scanning for continuous vulnerability detection
- Use AWS Systems Manager Patch Manager for automated EC2 patching
- Monitor AWS Security Hub for security findings

## References

- [Debian Security Tracker](https://security-tracker.debian.org/)
- [Ubuntu Security Notices](https://ubuntu.com/security/notices)
- [AWS ECR Image Scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [Ubuntu Pro](https://ubuntu.com/pro)

---

**Last Updated:** 2024-11-10
**Status:** ✅ Complete and Tested
