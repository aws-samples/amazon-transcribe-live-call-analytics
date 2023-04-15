#!/bin/bash

##############################################################################################
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
##############################################################################################

##############################################################################################
# Create new Cfn artifacts bucket if not already existing
# Modify templates to reference new bucket names and prefixes
# create lambda zipfiles with timestamps to ensure redeployment on stack update
# Upload templates to S3 bucket
#
# To deploy to non-default region, set AWS_DEFAULT_REGION to supported region
# See: https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/ - E.g.
# export AWS_DEFAULT_REGION=eu-west-1
##############################################################################################

STACK=lca-chimevc-stack

USAGE="$0 <cfn_bucket> <cfn_prefix> <region> [public]"

BUCKET=$1
[ -z "$BUCKET" ] && echo "Cfn bucket name is required parameter. Usage $USAGE" && exit 1

PREFIX=$2
[ -z "$PREFIX" ] && echo "Prefix is required parameter. Usage $USAGE" && exit 1

# Remove trailing slash from prefix if needed
[[ "${PREFIX}" == */ ]] && PREFIX="${PREFIX%?}"

REGION=$3
[ -z "$REGION" ] && echo "Region is a required parameter. Usage $USAGE" && exit 1
export AWS_DEFAULT_REGION=$REGION

ACL=$4
if [ "$ACL" == "public" ]; then
  echo "$STACK: Published S3 artifacts will be acessible by public (read-only)"
  PUBLIC=true
else
  PUBLIC=false
fi

# configure the nodejs layer first. npm run build will also run npm install
node_transcriber_layer_dir=lambda_layers/node_transcriber_layer
echo "Installing dependencies for $node_transcriber_layer_dir"
pushd $node_transcriber_layer_dir
npm run build
popd

# configure the boto3 layer
boto3_layer_dir=lambda_layers/boto3_layer
echo "Installing dependencies for $boto3_layer_dir"
pushd $boto3_layer_dir
pip install -r requirements.txt -t python/lib/python3.8/site-packages/.
zip -r boto3_lambda_layer.zip *
popd

# configure call transcriber
transcriber_dir=lambda_functions/call_transcriber
echo "Installing dependencies for $transcriber_dir"
pushd $transcriber_dir
npm install
popd

#chime_call_analytics_dir=lambda_functions/chime_call_analytics_initialization
#echo "Installing dependencies for $chime_call_analytics_dir"
#pushd $chime_call_analytics_dir
#npm install
#popd

pcaintegration_dir=lambda_functions/pca_integration
echo "Installing dependencies for $pcaintegration_dir"
pushd $pcaintegration_dir
npm install
popd

# Create bucket if it doesn't already exist
aws s3api list-buckets --query 'Buckets[].Name' | grep "\"$BUCKET\"" > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "$STACK: Creating s3 bucket: $BUCKET"
  aws s3 mb s3://${BUCKET} || exit 1
  aws s3api put-bucket-versioning --bucket ${BUCKET} --versioning-configuration Status=Enabled || exit 1
else
  echo "$STACK: Using existing bucket: $BUCKET"
fi

echo -n "$STACK: Make temp dir: "
timestamp=$(date "+%Y%m%d_%H%M")
tmpdir=/tmp/chimevcasterisk
[ -d $tmpdir ] && rm -fr $tmpdir
mkdir -p $tmpdir
pwd

# get bucket region for owned accounts
region=$(aws s3api get-bucket-location --bucket $BUCKET --query "LocationConstraint" --output text) || region="us-east-1"
[ -z "$region" -o "$region" == "None" ] && region=us-east-1;

echo "$STACK: Packaging Cfn artifacts"
MAIN_TEMPLATE=template.yaml
aws cloudformation package --template-file $MAIN_TEMPLATE --output-template-file $tmpdir/$MAIN_TEMPLATE --s3-bucket ${BUCKET} --s3-prefix ${PREFIX} || exit 1

aws s3 cp $tmpdir/$MAIN_TEMPLATE s3://${BUCKET}/${PREFIX}/$MAIN_TEMPLATE || exit 1

aws s3 cp ./demo-audio/agent.wav s3://${BUCKET}/${PREFIX}/demo-audio/agent.wav || exit 1

if $PUBLIC; then
  echo "$STACK: Setting public read ACLs on published artifacts"
  files=$(aws s3api list-objects --bucket ${BUCKET} --prefix ${PREFIX} --query "(Contents)[].[Key]" --output text)
  for file in $files
    do
    aws s3api put-object-acl --acl public-read --bucket ${BUCKET} --key $file
    done
fi

echo "$STACK: Validating Cfn artifacts"
template="https://s3.${region}.amazonaws.com/${BUCKET}/${PREFIX}/$MAIN_TEMPLATE"
aws cloudformation validate-template --template-url $template > /dev/null || exit 1

echo $STACK: Done publishing
exit 0

