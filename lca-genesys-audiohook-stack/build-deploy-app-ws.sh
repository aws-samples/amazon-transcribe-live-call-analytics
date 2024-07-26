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

dir=lca-genesys-audiohook-stack
echo "PACKAGING $dir"
pushd deployment
rm -rf ../out
chmod +x ./build-s3-dist.sh
./build-s3-dist.sh $BUCKET_BASENAME $PREFIX_AND_VERSION/$dir $VERSION $REGION || exit 1
popd

repo_arn=arn:aws:s3:::${BUCKET}/${PREFIX_AND_VERSION}/${dir}/${VERSION}/lca-talkdesk-ws.zip

echo $repo_arn

# buildid=$(aws codebuild start-build --project-name TranscriberCodeBuildProject-V3dCnMv8R2m0 --source-location-override $repo_arn --region $REGION | jq .build.id)
# echo "$buildid"
# while true; do 
#     buildstatus=$(aws codebuild batch-get-builds --ids "${buildid}" | jq .builds[0])
#     echo "$buildstatus"
#     if [[ ${buildstatus}!="IN PROGRESS" ]]; then
#         break;
#     fi
#     sleep 10s
# done
# aws codebuild start-build --project-name  --source-location-override <s3-arn> --region <region>
# aws ecs update-service --cluster <value> --service <value> --force-new-deployment --region <region>

# aws codebuild start-build --project-name TranscriberCodeBuildProject-V3dCnMv8R2m0 --source-location-override arn:aws:s3:::lca-solution-staging-752cf6e7c5a9-us-west-2/artifacts/0.8.76/lca-talkdesk-voicestream-stack/0.8.76/lca-talkdesk-ws.zip --region us-west-2
# aws ecs update-service --cluster lca-ts9-TALKDESKSTACK-1TAJ7OYUEW0RQ-TranscribingCluster-diE8udJl97mF --service lca-ts9-TALKDESKSTACK-1TAJ7OYUEW0RQ-TranscriberWebsocketFargateService-uCqgm7Ha2wzz --force-new-deployment --region us-west-2