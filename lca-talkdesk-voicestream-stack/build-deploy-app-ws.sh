BUCKET_BASENAME=$1
[ -z "$BUCKET_BASENAME" ] && echo "Cfn bucket name is a required parameter. Usage $USAGE" && exit 1

PREFIX=$2
[ -z "$PREFIX" ] && echo "Prefix is a required parameter. Usage $USAGE" && exit 1

REGION=$3
[ -z "$REGION" ] && echo "Region is a required parameter. Usage $USAGE" && exit 1
export AWS_DEFAULT_REGION=$REGION

# Remove trailing slash from prefix if needed, and append VERSION
VERSION=$(cat ../VERSION)
[[ "${PREFIX}" == */ ]] && PREFIX="${PREFIX%?}"
PREFIX_AND_VERSION=${PREFIX}/${VERSION}
BUCKET=${BUCKET_BASENAME}-${REGION}

dir=./source/app
echo "Building App"
pushd $dir
npm run setup
npm run buildcheck || exit 1
popd

dir=lca-talkdesk-voicestream-stack
echo "PACKAGING $dir"
pushd deployment
rm -rf ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/lca-talkdesk-voicestream-stack $VERSION $REGION || exit 1
popd

repo_arn=arn:aws:s3:::${BUCKET}/${PREFIX_AND_VERSION}/${dir}/${VERSION}/lca-talkdesk-ws.zip

echo $repo_arn
# aws codebuild start-build --project-name TranscriberCodeBuildProject-wbRLHS1k1QPo --source-location-override $repo_arn
