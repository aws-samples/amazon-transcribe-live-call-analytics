#!/bin/bash

# Clean and Build Script for LCA WebSocket Transcriber
# This script cleans up dependency conflicts and rebuilds the container

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== LCA WebSocket Transcriber Clean Build ===${NC}"

# Check if we're in the right directory
if [ ! -f "source/app/package.json" ]; then
    echo -e "${RED}Error: Please run this script from the lca-websocket-transcriber-stack directory${NC}"
    exit 1
fi

cd source/app

echo -e "${YELLOW}Step 1: Cleaning up old dependencies${NC}"
rm -f package-lock.json
rm -rf node_modules

echo -e "${YELLOW}Step 2: Installing fresh dependencies${NC}"
npm install

echo -e "${YELLOW}Step 3: Running build locally to test${NC}"
npm run buildcheck

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Local build successful${NC}"
else
    echo -e "${RED}✗ Local build failed${NC}"
    exit 1
fi

cd ../..

echo -e "${YELLOW}Step 4: Building Docker image${NC}"

# Check if stack name is provided
if [ -z "$1" ]; then
    echo -e "${YELLOW}No stack name provided, building test image only${NC}"
    docker build -t lca-websocket-test:latest source/app/
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Docker build successful${NC}"
        echo "Test image built as: lca-websocket-test:latest"
    else
        echo -e "${RED}✗ Docker build failed${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Stack name provided: $1${NC}"
    echo "Running full deployment..."
    ./update-ecs.sh "$1"
fi

echo -e "${GREEN}=== Clean Build Complete ===${NC}"