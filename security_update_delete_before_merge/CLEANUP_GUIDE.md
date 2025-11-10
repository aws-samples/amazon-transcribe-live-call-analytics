# Cleanup Guide for Pull Request

This guide helps you prepare a clean pull request with only the essential files.

## Files to KEEP (Include in PR)

### Core Documentation
```
security_update_delete_before_merge/
├── README.md (or README_SIMPLIFIED.md renamed to README.md)
├── CHANGES_SUMMARY.md
├── security_update_ecs.md
├── security_update_ec2.md
└── verify-security-updates.md
```

**Why keep these:**
- Provide clear instructions for users updating existing deployments
- Document what changed and why
- Serve as reference for future maintenance

## Files to DELETE (Exclude from PR)

### Redundant Scripts
```
security_update_delete_before_merge/
├── security-update-deployment.sh ❌ DELETE
├── minimal-security-update.sh ❌ DELETE
├── fix-dependencies.sh ❌ DELETE
├── fix-platform-architecture.sh ❌ DELETE
├── fix-patch-manager.sh ❌ DELETE
├── find-asterisk-instance.sh ❌ DELETE
├── update-ec2-security.sh ❌ DELETE
├── verify-security-updates.sh ❌ DELETE
└── verify-patch-management.sh ❌ DELETE
```

**Why delete these:**
- Functionality is covered by existing LCA scripts (`update-ecs.sh`)
- CloudFormation handles EC2 updates automatically
- AWS Console provides verification (ECR scans, Systems Manager)
- Reduces maintenance burden
- Simplifies the PR

### Development/Testing Files
```
security_update_delete_before_merge/
├── HOW_IT_WORKS.md ❌ DELETE (or keep as optional reference)
├── SECURITY_UPDATE_SUMMARY.md ❌ DELETE (superseded by CHANGES_SUMMARY.md)
└── mirador_findings/ ❌ DELETE (internal security scan results)
```

**Why delete these:**
- HOW_IT_WORKS.md is very detailed but most users don't need it
- SECURITY_UPDATE_SUMMARY.md was specific to one deployment
- mirador_findings/ contains internal security scan data

## Cleanup Commands

```bash
cd security_update_delete_before_merge

# Delete redundant scripts
rm -f security-update-deployment.sh
rm -f minimal-security-update.sh
rm -f fix-dependencies.sh
rm -f fix-platform-architecture.sh
rm -f fix-patch-manager.sh
rm -f find-asterisk-instance.sh
rm -f update-ec2-security.sh
rm -f verify-security-updates.sh
rm -f verify-patch-management.sh

# Delete development files
rm -f HOW_IT_WORKS.md
rm -f SECURITY_UPDATE_SUMMARY.md
rm -rf mirador_findings/

# Rename simplified README
mv README_SIMPLIFIED.md README.md

# Final directory structure
ls -la
```

## Final Directory Structure

After cleanup, your directory should look like:

```
security_update_delete_before_merge/
├── README.md                      # Overview and quick start
├── CHANGES_SUMMARY.md             # What changed and why
├── security_update_ecs.md         # ECS update guide
├── security_update_ec2.md         # EC2 update guide
└── verify-security-updates.md     # Verification procedures
```

**Total: 5 files** (down from 15+ files)

## Pull Request Description Template

```markdown
## Security Updates for LCA

### Summary
This PR addresses security vulnerabilities in container images and EC2 instances by updating vulnerable packages to their latest patched versions.

### Changes Made

#### Container Images (ECS)
- Updated Dockerfile to use Debian 12 (Bookworm) base image
- Added explicit security package updates for ncurses, gnutls, glibc, util-linux, and tar
- Fixed platform architecture for ECS Fargate compatibility

#### EC2 Instances (Asterisk Server)
- Added Ubuntu Pro ESM support for extended security updates
- Updated CloudFormation template to install security patches for liburiparser1 and libopusfile0
- Added optional UbuntuProToken parameter

#### Code Compatibility
- Fixed Fastify logging configuration
- Updated AWS SDK type compatibility
- Improved TypeScript type safety

### Files Changed
- `lca-websocket-transcriber-stack/source/app/Dockerfile`
- `lca-chimevc-stack/cloudformation-templates/chime-vc-with-asterisk-server.yaml`
- `lca-websocket-transcriber-stack/source/app/src/index.ts`
- `lca-websocket-transcriber-stack/source/app/src/lca.ts`
- `lca-websocket-transcriber-stack/source/app/src/whisper.ts`

### Documentation Added
- `security_update_delete_before_merge/README.md` - Overview and quick start
- `security_update_delete_before_merge/CHANGES_SUMMARY.md` - Detailed change log
- `security_update_delete_before_merge/security_update_ecs.md` - ECS update guide
- `security_update_delete_before_merge/security_update_ec2.md` - EC2 update guide
- `security_update_delete_before_merge/verify-security-updates.md` - Verification guide

### Testing
- ✅ Container builds successfully
- ✅ ECS tasks start and run without errors
- ✅ EC2 instances boot with security patches
- ✅ Application functionality maintained
- ✅ No breaking changes

### Deployment Impact
- **New deployments:** Automatic - security fixes included
- **Existing deployments:** Manual update required - see documentation

### Rollback Plan
Standard ECS task definition rollback and CloudFormation stack rollback procedures apply.
```

## Verification Checklist

Before submitting the PR:

- [ ] All redundant scripts deleted
- [ ] Only 5 documentation files remain
- [ ] README.md is clear and concise
- [ ] CHANGES_SUMMARY.md accurately describes changes
- [ ] All three guide files (ECS, EC2, verify) are complete
- [ ] No personal information (stack names, account IDs) in files
- [ ] All file paths in documentation are correct
- [ ] Code changes compile and pass tests
- [ ] Documentation is spell-checked

## Questions to Ask

Before finalizing:

1. **Do users need the scripts?**
   - No - existing LCA scripts handle updates
   - CloudFormation handles EC2 updates
   - AWS Console provides verification

2. **Is the documentation clear?**
   - Yes - three focused guides cover all scenarios
   - README provides quick overview
   - CHANGES_SUMMARY documents what changed

3. **Can this be maintained?**
   - Yes - minimal files to maintain
   - Clear structure and purpose
   - No complex scripts to debug

## Next Steps

1. Run the cleanup commands above
2. Review the final 5 files
3. Update any references to deleted files
4. Test the documentation by following the guides
5. Create the pull request with the template above
