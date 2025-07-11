#!/bin/bash

##############################################################################################
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
##############################################################################################

##############################################################################################
# Create new Cfn artifacts bucket if not already existing
# Build artifacts
# Upload artifacts to S3 bucket for deployment with CloudFormation
##############################################################################################

# Stop the publish process on failures
set -e

USAGE="$0 <cfn_bucket_basename> <cfn_prefix> <region> [public]"

build_container_lambda() {
  local dir=$1
  local ecr_repo=$2
  local region=$3
  
  # Get AWS account ID
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  
  # Create ECR repository if it doesn't exist
  aws ecr describe-repositories --repository-names ${ecr_repo} --region ${region} || \
    aws ecr create-repository --repository-name ${ecr_repo} --region ${region}
  
  # Get ECR login token
  aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com
  
  # Build and push container
  docker build -t ${ecr_repo}:latest ${dir}
  docker tag ${ecr_repo}:latest ${AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com/${ecr_repo}:latest
  docker push ${AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com/${ecr_repo}:latest
  
  # Return the ECR URI
  echo "${AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com/${ecr_repo}:latest"
}

if ! [ -x "$(command -v docker)" ]; then
echo 'Error: docker is not running and required.' >&2
echo 'Error: docker is not installed.' >&2
echo 'Install: https://docs.docker.com/engine/install/' >&2
exit 1
fi
if ! docker ps &> /dev/null; then
echo 'Error: docker is not running.' >&2
exit 1
fi
if ! [ -x "$(command -v sam)" ]; then
echo 'Error: sam is not installed and required.' >&2
echo 'Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html' >&2
exit 1
fi
sam_version=$(sam --version | awk '{print $4}')
min_sam_version="1.99.0"
if [[ $(echo -e "$min_sam_version\n$sam_version" | sort -V | tail -n1) == $min_sam_version && $min_sam_version != $sam_version ]]; then
  echo "Error: sam version >= $min_sam_version is not installed and required. (Installed version is $sam_version)" >&2
  echo 'Install: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/manage-sam-cli-versions.html' >&2
  exit 1
fi
if ! [ -x "$(command -v zip)" ]; then
echo 'Error: zip is not installed and required.' >&2
exit 1
fi
if ! [ -x "$(command -v pip3)" ]; then
echo 'Error: pip3 is not installed and required.' >&2
exit 1
fi
if ! python3 -c "import virtualenv"; then
echo 'Error: virtualenv python package is not installed and required.' >&2
echo 'Run "pip3 install virtualenv"' >&2
exit 1
fi
if ! [ -x "$(command -v npm)" ]; then
echo 'Error: npm is not installed and required.' >&2
exit 1
fi
if ! node -v | grep -qF "v18."; then
  echo 'Error: Node.js version 18.x is not installed and required.' >&2
  exit 1
fi

BUCKET_BASENAME=$1
[ -z "$BUCKET_BASENAME" ] && echo "Cfn bucket name is a required parameter. Usage $USAGE" && exit 1

PREFIX=$2
[ -z "$PREFIX" ] && echo "Prefix is a required parameter. Usage $USAGE" && exit 1

REGION=$3
[ -z "$REGION" ] && echo "Region is a required parameter. Usage $USAGE" && exit 1
export AWS_DEFAULT_REGION=$REGION

ACL=$4
if [ "$ACL" == "public" ]; then
echo "Published S3 artifacts will be acessible by public (read-only)"
PUBLIC=true
else
echo "Published S3 artifacts will NOT be acessible by public."
PUBLIC=false
fi

# Remove trailing slash from prefix if needed, and append VERSION
VERSION=$(cat ./VERSION)
[[ "${PREFIX}" == */ ]] && PREFIX="${PREFIX%?}"
PREFIX_AND_VERSION=${PREFIX}/${VERSION}

# Append region to bucket basename
BUCKET=${BUCKET_BASENAME}-${REGION}

# Create bucket if it doesn't already exist
if [ -x $(aws s3api list-buckets --query 'Buckets[].Name' | grep "\"$BUCKET\"") ]; then
echo "Creating s3 bucket: $BUCKET"
aws s3 mb s3://${BUCKET} || exit 1
aws s3api put-bucket-versioning --bucket ${BUCKET} --versioning-configuration Status=Enabled || exit 1
else
echo "Using existing bucket: $BUCKET"
fi

echo -n "Make temp dir: "
timestamp=$(date "+%Y%m%d_%H%M")
tmpdir=/tmp/lca
[ -d $tmpdir ] && rm -fr $tmpdir
mkdir -p $tmpdir
pwd


function calculate_hash() {
local directory_path=$1
local HASH=$(
  find "$directory_path" \( -name node_modules -o -name build \) -prune -o -type f -print0 | 
  sort -f -z |
  xargs -0 sha256sum |
  sha256sum |
  cut -d" " -f1 | 
  cut -c1-16
)
echo $HASH
}

# Function to check if any source files in the directory have been changed
haschanged() {
  local dir=$1
  local checksum_file="${dir}/.checksum"
  # Compute current checksum of the directory's modification times excluding specified directories, and the publish target S3 location.
  dir_checksum=$(find "$dir" -type d \( -name "python" -o -name "node_modules" -o -name "build" \) -prune -o -type f ! -name ".checksum" -exec stat --format='%Y' {} \; | sha256sum | awk '{ print $1 }')
  combined_string="$BUCKET $PREFIX_AND_VERSION $REGION $dir_checksum"
  current_checksum=$(echo -n "$combined_string" | sha256sum | awk '{ print $1 }')
  # Check if the checksum file exists and read the previous checksum
  if [ -f "$checksum_file" ]; then
      previous_checksum=$(cat "$checksum_file")
  else
      previous_checksum=""
  fi
  if [ "$current_checksum" != "$previous_checksum" ]; then
      return 0  # True, the directory has changed
  else
      return 1  # False, the directory has not changed
  fi
}
update_checksum() {
  local dir=$1
  local checksum_file="${dir}/.checksum"
  # Compute current checksum of the directory's modification times excluding specified directories, and the publish target S3 location.
  dir_checksum=$(find "$dir" -type d \( -name "python" -o -name "node_modules" -o -name "build" \) -prune -o -type f ! -name ".checksum" -exec stat --format='%Y' {} \; | sha256sum | awk '{ print $1 }')
  combined_string="$BUCKET $PREFIX_AND_VERSION $REGION $dir_checksum"
  current_checksum=$(echo -n "$combined_string" | sha256sum | awk '{ print $1 }')
  # Save the current checksum
  echo "$current_checksum" > "$checksum_file"
}

# Function to check if the submodule commit hash has changed
hassubmodulechanged() {
    local dir=$1
    local hash_file="${dir}/.commit-hash"
    # Get the current commit hash of the submodule
    cd "$dir" || exit 1
    current_hash=$(git rev-parse HEAD)
    cd - > /dev/null || exit 1
    # Check if the hash file exists and read the previous hash
    if [ -f "$hash_file" ]; then
        previous_hash=$(cat "$hash_file")
    else
        previous_hash=""
    fi
    if [ "$current_hash" != "$previous_hash" ]; then
        return 0  # True, the submodule has changed
    else
        return 1  # False, the submodule has not changed
    fi
}
update_submodule_hash() {
    local dir=$1
    local hash_file="${dir}/.commit-hash"
    # Get the current commit hash of the submodule
    cd "$dir" || exit 1
    current_hash=$(git rev-parse HEAD)
    cd - > /dev/null || exit 1
    # Save the current hash
    echo "$current_hash" > "$hash_file"
}

dir=lca-chimevc-stack
if haschanged $dir; then
  echo "PACKAGING $dir"
  pushd $dir
  
  # Build container for call transcriber
  ECR_URI=$(build_container_lambda "lambda_functions/call_transcriber" "lca-call-transcriber" ${REGION})
  echo "Container image URI: ${ECR_URI}"
  
  # Continue with rest of packaging
  ./publish.sh $BUCKET $PREFIX_AND_VERSION/$dir $REGION || exit 1
  popd
  update_checksum $dir
else
  echo "SKIPPING $dir (unchanged)"
fi

dir=lca-connect-kvs-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
./publish.sh $BUCKET $PREFIX_AND_VERSION/$dir $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-genesys-audiohook-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir/deployment
rm -rf ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/$dir $VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-talkdesk-voicestream-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir/deployment
rm -rf ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/$dir $VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-websocket-transcriber-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir/deployment
rm -rf ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/$dir $VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-connect-integration-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
aws s3 cp ./template.yaml s3://${BUCKET}/${PREFIX_AND_VERSION}/$dir/template.yaml
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-ai-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir/deployment
rm -fr ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/$dir $VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-llm-template-setup-stack
if haschanged $dir; then
echo "PACKAGING $dir/deployment"
pushd $dir/deployment
# by hashing the contents of the source folder, we can force the custom resource lambda to re-run
# when the code or prompt template contents change.
echo "Computing hash of src folder contents"
HASH=$(calculate_hash "../source")
template=llm-template-setup.yaml
echo "Replace hash in template"
# Detection of differences. sed varies betwen GNU sed and BSD sed
if sed --version 2>/dev/null | grep -q GNU; then # GNU sed
  sed -i 's/source_hash: .*/source_hash: '"$HASH"'/' ${template}
else # BSD like sed
  sed -i '' 's/source_hash: .*/source_hash: '"$HASH"'/' ${template}
fi
s3_template="s3://${BUCKET}/${PREFIX_AND_VERSION}/lca-llm-template-setup-stack/llm-template-setup.yaml"
aws cloudformation package \
--template-file ${template} \
--output-template-file ${tmpdir}/${template} \
--s3-bucket $BUCKET --s3-prefix ${PREFIX_AND_VERSION}/lma-llm-template-setup-stack \
--region ${REGION} || exit 1
echo "Uploading template file to: ${s3_template}"
aws s3 cp ${tmpdir}/${template} ${s3_template}
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=submodule-aws-qnabot
echo "UPDATING $dir"
git submodule init
echo "Removing any QnAbot changes from previous builds"
pushd $dir && git checkout . && popd
git submodule update
# lca customizations
echo "Applying patch files to remove unused KMS keys from QnABot and customize designer settings page"
cp -v ./patches/qnabot/templates_examples_examples_index.js $dir/source/templates/examples/examples/index.js
cp -v ./patches/qnabot/templates_examples_extensions_index.js $dir/source/templates/examples/extensions/index.js
cp -v ./patches/qnabot/website_js_lib_store_api_actions_settings.js $dir/source/website/js/lib/store/api/actions/settings.js
echo "modify QnABot version string from 'N.N.N' to 'N.N.N-lca'"
# Detection of differences. sed varies betwen GNU sed and BSD sed
if sed --version 2>/dev/null | grep -q GNU; then # GNU sed
  sed -i 's/"version": *"\([0-9]*\.[0-9]*\.[0-9]*\)"/"version": "\1-lca"/' $dir/source/package.json
else # BSD like sed
  sed -i '' 's/"version": *"\([0-9]*\.[0-9]*\.[0-9]*\)"/"version": "\1-lca"/' $dir/source/package.json
fi
echo "Creating config.json"
cat > $dir/source/config.json <<_EOF
{
  "profile": "${AWS_PROFILE:-default}",
  "region": "${REGION}",
  "buildType": "Custom",
  "skipCheckTemplate":true,
  "noStackOutput": true
}
_EOF

# only re-build QnABot if patch files or submodule version has changed
if haschanged ./patches/qnabot || hassubmodulechanged $dir; then

echo "PACKAGING $dir"

pushd $dir/source
mkdir -p build/templates/dev
npm install
npm run build || exit 1
# Rename OpenbsearchDomain resource in template to force resource replacement during upgrade/downgrade
# If the resource name is not changed, then CloudFomration does an inline upgrade from OpenSearch 1.3 to 2.1, but this upgrade cannot be reversed
# which can create a problem with ROLLBACK if there is a stack failure during the upgrade.
cat ./build/templates/master.json | sed -e "s%OpensearchDomain%LMAQnaBotOpensearchDomain%g" > ./build/templates/qnabot-main.json
aws s3 sync ./build/ s3://${BUCKET}/${PREFIX_AND_VERSION}/aws-qnabot/ --delete 
popd
update_checksum ./patches/qnabot
update_submodule_hash $dir
else
echo "SKIPPING $dir (unchanged)"
fi


dir=lca-vpc-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
template=template.yaml
s3_template="s3://${BUCKET}/${PREFIX_AND_VERSION}/${dir}/template.yaml"
https_template="https://s3.${REGION}.amazonaws.com/${BUCKET}/${PREFIX_AND_VERSION}/${dir}/template.yaml"
aws cloudformation package \
--template-file ${template} \
--output-template-file ${tmpdir}/${template} \
--s3-bucket $BUCKET --s3-prefix ${PREFIX_AND_VERSION}/${dir} \
--region ${REGION} || exit 1
echo "Uploading template file to: ${s3_template}"
aws s3 cp ${tmpdir}/${template} ${s3_template}
echo "Validating template"
aws cloudformation validate-template --template-url ${https_template} > /dev/null || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-agentassist-setup-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
./publish.sh $BUCKET $PREFIX_AND_VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-bedrockkb-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
./publish.sh $BUCKET $PREFIX_AND_VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

dir=lca-whisper-sagemaker-stack
if haschanged $dir; then
echo "PACKAGING $dir"
pushd $dir
./publish.sh $BUCKET $PREFIX_AND_VERSION $REGION || exit 1
popd
update_checksum $dir
else
echo "SKIPPING $dir (unchanged)"
fi

echo "PACKAGING Main Stack Cfn artifacts"
MAIN_TEMPLATE=lca-main.yaml
MAIN_TEMPLATE_WITH_VERSION=lca-main-${VERSION}.yaml

echo "Inline edit $MAIN_TEMPLATE to replace "
echo "   <ARTIFACT_BUCKET_TOKEN> with bucket name: $BUCKET"
echo "   <ARTIFACT_PREFIX_TOKEN> with prefix: $PREFIX_AND_VERSION"
echo "   <VERSION_TOKEN> with version: $VERSION"
echo "   <REGION_TOKEN> with region: $REGION"
cat ./$MAIN_TEMPLATE | 
sed -e "s%<ARTIFACT_BUCKET_TOKEN>%$BUCKET%g" | 
sed -e "s%<ARTIFACT_PREFIX_TOKEN>%$PREFIX_AND_VERSION%g" |
sed -e "s%<VERSION_TOKEN>%$VERSION%g" |
sed -e "s%<REGION_TOKEN>%$REGION%g" > $tmpdir/$MAIN_TEMPLATE
# upload main template
aws s3 cp $tmpdir/$MAIN_TEMPLATE s3://${BUCKET}/${PREFIX}/$MAIN_TEMPLATE || exit 1
aws s3 cp $tmpdir/$MAIN_TEMPLATE s3://${BUCKET}/${PREFIX}/${MAIN_TEMPLATE_WITH_VERSION} || exit 1

template="https://s3.${REGION}.amazonaws.com/${BUCKET}/${PREFIX}/${MAIN_TEMPLATE}"
echo "Validating template: $template"
aws cloudformation validate-template --template-url $template > /dev/null || exit 1

if $PUBLIC; then
echo "Setting public read ACLs on published artifacts"
files=$(aws s3api list-objects --bucket ${BUCKET} --prefix ${PREFIX_AND_VERSION} --query "(Contents)[].[Key]" --output text)
c=$(echo $files | wc -w)
counter=0
for file in $files
  do
  aws s3api put-object-acl --acl public-read --bucket ${BUCKET} --key $file
  counter=$((counter + 1))
  echo -ne "Progress: $counter/$c files processed\r"
  done
aws s3api put-object-acl --acl public-read --bucket ${BUCKET} --key ${PREFIX}/${MAIN_TEMPLATE}
echo ""
echo "Done."
fi

echo "OUTPUTS"
echo Template URL: $template
echo CF Launch URL: https://${REGION}.console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/create/review?templateURL=${template}\&stackName=LCA
echo CLI Deploy: aws cloudformation deploy --region $REGION --template-file $tmpdir/$MAIN_TEMPLATE --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND --stack-name LCA --parameter-overrides AdminEmail='jdoe@example.com' CallAudioSource='Demo Asterisk PBX Server' demoSoftphoneAllowedCidr=CIDRBLOCK siprecAllowedCidrList=\"\" S3BucketName=\"\"
echo Done
exit 0
