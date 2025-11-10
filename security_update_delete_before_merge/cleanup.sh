#!/bin/bash

# Cleanup script for security_update directory
# This removes redundant files and prepares for a clean pull request

set -e

echo "=== LCA Security Update Cleanup ==="
echo ""
echo "This script will:"
echo "  1. Delete redundant shell scripts"
echo "  2. Delete development/testing files"
echo "  3. Rename README_SIMPLIFIED.md to README.md"
echo "  4. Show final directory structure"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cleanup cancelled."
    exit 0
fi

echo ""
echo "Step 1: Deleting redundant scripts..."

# Delete redundant scripts
rm -fv security-update-deployment.sh
rm -fv minimal-security-update.sh
rm -fv fix-dependencies.sh
rm -fv fix-platform-architecture.sh
rm -fv fix-patch-manager.sh
rm -fv find-asterisk-instance.sh
rm -fv update-ec2-security.sh
rm -fv verify-security-updates.sh
rm -fv verify-patch-management.sh

echo ""
echo "Step 2: Deleting development files..."

# Delete development files
rm -fv HOW_IT_WORKS.md
rm -fv SECURITY_UPDATE_SUMMARY.md

# Delete mirador findings directory
if [ -d "mirador_findings" ]; then
    rm -rfv mirador_findings/
fi

echo ""
echo "Step 3: Renaming README..."

# Backup original README if it exists
if [ -f "README.md" ]; then
    mv -v README.md README.md.backup
fi

# Rename simplified README
if [ -f "README_SIMPLIFIED.md" ]; then
    mv -v README_SIMPLIFIED.md README.md
fi

echo ""
echo "Step 4: Final directory structure:"
echo ""
ls -lh

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "Files remaining:"
echo "  ✓ README.md"
echo "  ✓ CHANGES_SUMMARY.md"
echo "  ✓ CLEANUP_GUIDE.md"
echo "  ✓ security_update_ecs.md"
echo "  ✓ security_update_ec2.md"
echo "  ✓ verify-security-updates.md"
echo "  ✓ cleanup.sh (this script - can be deleted after use)"
echo ""
echo "Next steps:"
echo "  1. Review the remaining files"
echo "  2. Delete cleanup.sh if desired: rm cleanup.sh"
echo "  3. Delete CLEANUP_GUIDE.md if desired: rm CLEANUP_GUIDE.md"
echo "  4. Commit changes and create pull request"
echo ""
