# Security Updates for EC2 Asterisk Server

This guide walks you through applying and verifying security updates on the EC2 Asterisk server used for demo purposes in LCA.

## Prerequisites

- Access to AWS Console
- Your LCA Chime VC Stack with Asterisk Demo enabled (e.g., `LCA-johnsmith-CHIMEVCSTACK-XXX-ChimeVCAsteriskDemoStack-XXX`)
- SSM Session Manager access (or SSH access if configured)

## Overview

The Asterisk demo server runs on Ubuntu 20.04 and requires security patches for:
- `liburiparser1` - URI parsing library vulnerability
- `libopusfile0` - Opus audio file library vulnerability
- Other system packages (ncurses, gnutls, libc6, util-linux, tar)

## Step 1: Find Your Asterisk EC2 Instance

### Option A: Using CloudFormation Console

1. Open the [AWS CloudFormation Console](https://console.aws.amazon.com/cloudformation)
2. Find your Chime VC Asterisk Demo stack (usually named like `LCA-{username}-CHIMEVCSTACK-XXX-ChimeVCAsteriskDemoStack-XXX`)
3. Click on the stack name
4. Go to the **Resources** tab
5. Look for a resource with:
   - **Logical ID**: `AsteriskInstance`
   - **Type**: `AWS::EC2::Instance`
6. Note the **Physical ID** (this is your instance ID, e.g., `i-0123456789abcdef0`)

### Option B: Using AWS CLI

```bash
# Set your stack name
STACK_NAME="LCA-johnsmith-CHIMEVCSTACK-XXX-ChimeVCAsteriskDemoStack-XXX"

# Get the instance ID
INSTANCE_ID=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --logical-resource-id AsteriskInstance \
    --query "StackResources[0].PhysicalResourceId" \
    --output text)

echo "Instance ID: $INSTANCE_ID"
```

## Step 2: Connect to the Instance

### Option A: Using AWS Systems Manager Session Manager (Recommended)

1. Go to [AWS Systems Manager Console](https://console.aws.amazon.com/systems-manager/session-manager)
2. Click **Start session**
3. Select your Asterisk instance from the list
4. Click **Start session**

### Option B: Using AWS CLI

```bash
# Connect via Session Manager
aws ssm start-session --target "$INSTANCE_ID"
```

### Option C: Using SSH (if configured)

```bash
# If you have SSH access configured
ssh -i /path/to/your-key.pem ubuntu@<instance-public-ip>
```

## Step 3: Enable Ubuntu Pro (Free for Personal Use)

Ubuntu Pro provides Extended Security Maintenance (ESM) for packages not in the main Ubuntu repository.

```bash
# Check if Ubuntu Pro is already enabled
sudo pro status

# If not enabled, attach with a free token
# Get your free token at: https://ubuntu.com/pro
sudo pro attach <your-token>

# Enable ESM Apps (required for liburiparser1 and libopusfile0)
sudo pro enable esm-apps
```

**Note:** Ubuntu Pro is free for personal use on up to 5 machines. Get your token at https://ubuntu.com/pro

## Step 4: Update Package Lists

```bash
# Update package lists (including ESM repositories)
sudo apt-get update
```

## Step 5: Check Current Package Versions

Before updating, check the current versions:

```bash
# Check vulnerable packages
dpkg -l | grep -E 'liburiparser1|libopusfile0'

# Or check specific packages
dpkg -l liburiparser1
dpkg -l libopusfile0
```

## Step 6: Apply Security Updates

### Option A: Update All Packages (Recommended)

```bash
# Upgrade all packages to latest security-patched versions
sudo apt-get upgrade -y

# If you want to also upgrade packages that require new dependencies
sudo apt-get dist-upgrade -y
```

### Option B: Update Only Specific Vulnerable Packages

```bash
# Update specific vulnerable packages
sudo apt-get install --only-upgrade \
    liburiparser1 \
    libopusfile0 \
```

## Step 7: Verify Updates Were Applied

Check the updated package versions:

```bash
# Check all security-relevant packages
dpkg -l | grep -E 'liburiparser1|libopusfile0'

# Or check specific packages
dpkg -l liburiparser1
dpkg -l libopusfile0
```

## Expected Package Versions

After applying updates on Ubuntu 20.04 with ESM enabled, you should see:

| Package | Minimum Secure Version | Source |
|---------|------------------------|--------|
| liburiparser1 | 0.9.6+dfsg-1ubuntu0.1~esm1 | ESM Apps |
| libopusfile0 | 0.9+20170913-1.1ubuntu0.1~esm1 | ESM Apps |

### Example Output:

```
ii  libopusfile0:amd64    0.9+20170913-1.1ubuntu0.1~esm1  amd64  High-level API for Opus audio files
ii  liburiparser1:amd64   0.9.6+dfsg-1ubuntu0.1~esm1      amd64  URI parsing library
```

## Step 8: Restart Services (if needed)

Some updates may require restarting services or the instance:

```bash
# Check if a reboot is required
if [ -f /var/run/reboot-required ]; then
    echo "Reboot required"
    cat /var/run/reboot-required.pkgs
fi

# Restart Asterisk service (if it was updated)
sudo systemctl restart asterisk

# Or reboot the instance (if required)
sudo reboot
```

## Step 9: Verify Asterisk is Running

After updates, verify Asterisk is still functioning:

```bash
# Check Asterisk status
sudo systemctl status asterisk

# Check Asterisk CLI
sudo asterisk -rx "core show version"

# Test SIP connectivity
sudo asterisk -rx "sip show peers"
```

## Automated Update Script

You can automate these steps with a script:

```bash
#!/bin/bash
set -e

echo "=== Asterisk EC2 Security Update ==="

# Enable Ubuntu Pro if not already enabled
if ! sudo pro status | grep -q "esm-apps.*enabled"; then
    echo "Ubuntu Pro ESM not enabled. Please run: sudo pro attach <token>"
    exit 1
fi

# Update package lists
echo "Updating package lists..."
sudo apt-get update

# Show current versions
echo "Current package versions:"
dpkg -l | grep -E 'liburiparser1|libopusfile0'

# Apply updates
echo "Applying security updates..."
sudo apt-get upgrade -y

# Show updated versions
echo "Updated package versions:"
dpkg -l | grep -E 'liburiparser1|libopusfile0'

# Check if reboot required
if [ -f /var/run/reboot-required ]; then
    echo "WARNING: Reboot required for updates to take effect"
    cat /var/run/reboot-required.pkgs
fi

echo "=== Update Complete ==="
```

## Using AWS Systems Manager Patch Manager (Automated)

For automated patching, you can use AWS Systems Manager Patch Manager:

### Step 1: Create a Patch Baseline

1. Go to [AWS Systems Manager Console](https://console.aws.amazon.com/systems-manager/patch-manager)
2. Click **Patch baselines** in the left menu
3. Click **Create patch baseline**
4. Configure:
   - **Name**: `LCA-Asterisk-Security-Patches`
   - **Operating system**: Ubuntu
   - **Approval rules**: Approve patches after 0 days
   - **Include non-security updates**: Optional
5. Click **Create patch baseline**

### Step 2: Create a Maintenance Window

1. In Systems Manager, click **Maintenance Windows**
2. Click **Create maintenance window**
3. Configure:
   - **Name**: `LCA-Asterisk-Patching`
   - **Schedule**: Choose your preferred schedule (e.g., weekly on Sunday at 2 AM)
   - **Duration**: 2 hours
   - **Stop after**: 1 hour
4. Click **Create maintenance window**

### Step 3: Register Target

1. Click on your maintenance window
2. Click **Actions** → **Register targets**
3. Select **Specifying instance tags** or **Selecting instances manually**
4. Select your Asterisk instance
5. Click **Register target**

### Step 4: Register Task

1. Click **Actions** → **Register Run command task**
2. Configure:
   - **Document**: `AWS-RunPatchBaseline`
   - **Task priority**: 1
   - **Targets**: Select the target you created
   - **Operation**: Install
3. Click **Register Run command task**

Now your Asterisk instance will be automatically patched according to the schedule.

## Troubleshooting

### Ubuntu Pro Not Available

If you can't enable Ubuntu Pro:

```bash
# Install the ubuntu-advantage-tools package
sudo apt-get update
sudo apt-get install ubuntu-advantage-tools -y

# Try attaching again
sudo pro attach <your-token>
```

### ESM Packages Not Found

If `liburiparser1` or `libopusfile0` updates aren't found:

```bash
# Verify ESM is enabled
sudo pro status

# Manually enable ESM Apps
sudo pro enable esm-apps

# Update package lists
sudo apt-get update
```

### SSM Session Manager Not Working

If you can't connect via Session Manager:

1. Verify the instance has the SSM agent installed and running:
   ```bash
   sudo systemctl status amazon-ssm-agent
   ```

2. Check the instance has the required IAM role with `AmazonSSMManagedInstanceCore` policy

3. Verify the instance is registered with SSM:
   ```bash
   aws ssm describe-instance-information \
       --filters "Key=InstanceIds,Values=$INSTANCE_ID"
   ```

### Asterisk Won't Start After Update

If Asterisk fails to start after updates:

```bash
# Check Asterisk logs
sudo journalctl -u asterisk -n 50

# Check Asterisk configuration
sudo asterisk -rx "core show settings"

# Try starting in verbose mode
sudo asterisk -cvvv
```

## Security Best Practices

1. **Enable Ubuntu Pro** - Free for personal use, provides ESM updates
2. **Enable automatic security updates**:
   ```bash
   sudo apt-get install unattended-upgrades -y
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```

3. **Use Systems Manager Patch Manager** for automated patching
4. **Monitor patch compliance** in AWS Security Hub
5. **Test updates in a non-production environment** first
6. **Keep backups** before applying major updates

## Verification Checklist

- [ ] Ubuntu Pro enabled and ESM Apps active
- [ ] Package lists updated (`apt-get update`)
- [ ] Security updates applied (`apt-get upgrade`)
- [ ] `liburiparser1` version includes `~esm1`
- [ ] `libopusfile0` version includes `~esm1`
- [ ] Asterisk service is running
- [ ] SIP connectivity is working
- [ ] No reboot required (or reboot completed)
- [ ] Security Hub findings resolved
