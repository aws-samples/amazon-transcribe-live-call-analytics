# Pull Request: Security Updates for LCA

## Summary

This PR addresses security vulnerabilities in container images and EC2 instances by updating vulnerable packages to their latest patched versions. All security fixes are integrated into the CloudFormation templates and Dockerfiles, requiring no additional scripts or manual intervention for new deployments.

## Problem Statement

Security scans identified vulnerabilities in:
- **Container images**: ncurses, gnutls, glibc, util-linux, tar
- **EC2 instances**: liburiparser1, libopusfile0

These vulnerabilities range from medium to critical severity and require patching to maintain security compliance.

## Solution

### Container Images (ECS)
- Updated Dockerfile to use Debian 12 (Bookworm) base image with latest security patches
- Added explicit `apt-get upgrade` commands for vulnerable packages
- Fixed platform architecture specification for ECS Fargate compatibility (`--platform=linux/amd64`)

### EC2 Instances (Asterisk Server)
- Added Ubuntu Pro ESM (Extended Security Maintenance) support
- Updated CloudFormation template to install security patches during instance launch
- Added optional `UbuntuProToken` parameter for ESM access

### Code Compatibility
- Fixed Fastify logging configuration (migrated from deprecated `prettyPrint` to `transport`)
- Updated AWS SDK type compatibility
- Improved TypeScript type safety

## Files Changed

### Core Application Files
```
lca-websocket-transcriber-stack/source/app/
├── Dockerfile                    # Security updates + platform fix
├── src/index.ts                  # Fastify logging fix
├── src/lca.ts                    # AWS SDK type fix
└── src/whisper.ts                # Logging compatibility fix

lca-chimevc-stack/cloudformation-templates/
└── chime-vc-with-asterisk-server.yaml  # EC2 security updates
```

### Documentation Added
```
security_update_delete_before_merge/
├── README.md                     # Overview and quick start
├── CHANGES_SUMMARY.md            # Detailed change log
├── security_update_ecs.md        # ECS update guide
├── security_update_ec2.md        # EC2 update guide
└── verify-security-updates.md    # Verification procedures
```

## Security Vulnerabilities Addressed

### Container Images
| Package | Severity | Status |
|---------|----------|--------|
| ncurses | High | ✅ Fixed |
| gnutls | High | ✅ Fixed |
| glibc | Critical | ✅ Fixed |
| util-linux | Medium | ✅ Fixed |
| tar | Medium | ✅ Fixed |

### EC2 Instances
| Package | Severity | Status |
|---------|----------|--------|
| liburiparser1 | High | ✅ Fixed |
| libopusfile0 | Medium | ✅ Fixed |

## Testing Performed

- ✅ Container builds successfully with security updates
- ✅ ECS tasks start and run without errors on Fargate
- ✅ Platform architecture compatibility verified (linux/amd64)
- ✅ Application functionality maintained (transcription, WebSocket, etc.)
- ✅ EC2 instance boots successfully with security patches
- ✅ Asterisk service remains operational after updates
- ✅ TypeScript compilation passes without errors
- ✅ ESLint checks pass
- ✅ No breaking changes to application code

## Deployment Impact

### For New Deployments
✅ **Automatic** - All security fixes are included when deploying with updated CloudFormation templates. No additional steps required.

### For Existing Deployments
⚠️ **Manual Update Required** - Existing deployments need to be updated to apply security patches:

**ECS Containers:**
```bash
cd lca-websocket-transcriber-stack
./update-ecs.sh <your-stack-name>
```

**EC2 Instances:**
```bash
aws cloudformation update-stack \
  --stack-name <your-asterisk-stack-name> \
  --use-previous-template \
  --capabilities CAPABILITY_IAM
```

See documentation in `security_update_delete_before_merge/` for detailed instructions.

## Rollback Plan

### ECS Containers
```bash
aws ecs update-service \
  --cluster <cluster-name> \
  --service <service-name> \
  --task-definition <previous-task-definition-arn>
```

### EC2 Instances
```bash
aws cloudformation cancel-update-stack --stack-name <stack-name>
```

## Breaking Changes

**None** - All updates are backward compatible and maintain existing functionality.

## Documentation

Comprehensive documentation has been added to guide users through:
1. Understanding what changed and why
2. Updating existing ECS containers
3. Updating existing EC2 instances
4. Verifying security updates were applied successfully
5. Troubleshooting common issues

## Future Maintenance

### Recommended Update Schedule
- **Container Images**: Monthly or when critical CVEs are published
- **EC2 Instances**: Quarterly or when ESM updates are available
- **Dependencies**: Review quarterly for security updates

### Monitoring
- Enable ECR image scanning for continuous vulnerability detection
- Use AWS Systems Manager Patch Manager for automated EC2 patching
- Monitor AWS Security Hub for security findings

## Checklist

- [x] Code changes compile and pass tests
- [x] Documentation is complete and accurate
- [x] Security vulnerabilities are resolved
- [x] No breaking changes introduced
- [x] Rollback procedure documented
- [x] Testing performed in development environment
- [x] No personal information (account IDs, stack names) in code

## References

- [Debian Security Tracker](https://security-tracker.debian.org/)
- [Ubuntu Security Notices](https://ubuntu.com/security/notices)
- [AWS ECR Image Scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- [Ubuntu Pro](https://ubuntu.com/pro)

---

**Reviewers:** Please verify:
1. Security updates are correctly applied in Dockerfile and CloudFormation template
2. Documentation is clear and complete
3. No sensitive information is exposed
4. Changes maintain backward compatibility
