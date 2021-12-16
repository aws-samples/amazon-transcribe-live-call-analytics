# Amazon Transcribe Live Call Analytics (LCA) Sample Solution 
The Amazon Transcribe Live Call Analytics (LCA) Sample Solution provides the combination of speech to text transcription, translation into preferred languages, and insights for agents and supervisors all in real-time. This enables agents to better understand customer needs and drive resolution using the insights the solution provides while they are still interacting with their customer.

This sample solution deploys resources that consume audio from any producer that streams to Amazon Kinesis Video Streams (KVS), uses Amazon Transcribe real-time streaming for transcription, Amazon Comprehend for sentiment analysis, and provides a demo website to demonstrate live call analytics capabilities.

## Building distributable for customization

### Requirements

This project is developed and tested on Amazon Linux 2 using AWS Cloud9. These
are the minimum requirements for building the solution:

- [AWS CLI](https://aws.amazon.com/cli/)
- SAM CLI - [Install the SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
- [Python 3 installed](https://www.python.org/downloads/)
- Docker - [Install Docker community edition](https://hub.docker.com/search/?type=edition&offering=community)

### Build and S3 staging steps

* Configure the bucket name of your target Amazon S3 distribution bucket
```
export DIST_OUTPUT_BUCKET=my-bucket-name # bucket where customized code will reside
export SOLUTION_NAME=my-solution-name
export VERSION=my-version # version number for the customized code
```
_Note:_ You would have to create an S3 bucket with the prefix 'my-bucket-name-<aws_region>'; aws_region is where you are testing the customized solution. Also, the assets in bucket should be publicly accessible.

* Now build and upload the distributable template and artifacts:
```
cd deployment &&
chmod +x ./build-s3-dist.sh \n
./build-s3-dist.sh $DIST_OUTPUT_BUCKET $SOLUTION_NAME $VERSION \n
```

* Get the link of the solution template uploaded to your Amazon S3 bucket (in the output of the previous command).
* Deploy the solution to your account by launching a new AWS CloudFormation stack using the link of the solution template in Amazon S3.

## Connecting this solution with Amazon Chime Voice Connector
_Pre-requisites_: You need to [enable KVS Streaming](https://docs.aws.amazon.com/chime/latest/ag/start-kinesis-vc.html) on the Amazon Chime SDK Voice Connector used in your environment. When you enable Amazon Chime SDK Voice Connector streaming, make sure to select AWS EventBridge as the streaming trigger. **This solution already hooks up an EventBridge rule to the lambda triggers provided for Fargate.**

* You can trigger the `transcribingFargateTrigger` lambda function from the Amazon Chime Voice Connector
* We expect the following event from Amazon Chime SDK Voice Connector to start/stop transcription:
```
{
    "version": "0",
    "id": "8a9fdef1-5a7f-a21c-9316-5323a4add6ce",
    "detail-type": "Chime VoiceConnector Streaming Status",
    "source": "aws.chime",
    "account": "253873381732",
    "time": "2021-10-11T17: 52: 17Z",
    "region": "us-east-1",
    "resources": [],
    "detail": {
        "callId": "945a7111-4cea-41e2-b595-0a92357c71a9",
        "direction": "Outbound",
        "fromNumber": "+16187380858",
        "inviteHeaders": {
            "record-route": "<sip: 3.80.16.11;lr;ftag=0f052c39-457b-48b6-a8fc-0d815d553237;did=1b21.5631;nat=yes>",
            "via": "SIP/2.0/UDP 3.80.16.11: 5060;branch=z9hG4bKc4bd.53e495a850daea71fa943001d43d9089.0;received=10.0.156.52;rport=5060,SIP/2.0/UDP 3.90.117.176: 5060;received=3.90.117.176;rport=5060;branch=z9hG4bKPj95ae6679-47e7-4e31-8170-3bf809236a71",
            "from": "<sip:+16187380858@10.0.0.202>;tag=0f052c39-457b-48b6-a8fc-0d815d553237",
            "to": "<sip:+18123610485@dip1c02pjd3bkznvs6wwmu.voiceconnector.chime.aws>",
            "contact": "<sip:asterisk@3.90.117.176: 5060>",
            "call-id": "945a7111-4cea-41e2-b595-0a92357c71a9",
            "cseq": "27005 INVITE",
            "allow": "OPTIONS, REGISTER, SUBSCRIBE, NOTIFY, PUBLISH, INVITE, ACK, BYE, CANCEL, UPDATE, PRACK, MESSAGE, REFER",
            "supported": "100rel, timer, replaces, norefersub, histinfo",
            "session-expires": "1800",
            "min-se": "90",
            "max-forwards": "69",
            "user-agent": "Asterisk PBX 16.20.0",
            "content-type": "application/sdp",
            "content-length": "452"
        },
        "isCaller": "True",
        "mediaType": "audio/L16",
        "startFragmentNumber": "91343852333181447247962534065089262372655059081",
        "startTime": "2021-10-11T17: 52: 17.524Z",
        "streamArn": "arn:aws:kinesisvideo:us-east-1: 253873381732:stream/ChimeVoiceConnector-dip1c02pjd3bkznvs6wwmu-fc503996-4d83-4732-ad40-eda969ab32a8/1633411045410",
        "toNumber": "+18123610485",
        "transactionId": "98a333db-f5c1-4e90-9935-372d18cb9e26",
        "voiceConnectorId": "dip1c02pjd3bkznvs6wwmu",
        "streamingStatus": "STARTED",
        "version": "0"
    }
}

```

***

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0

Licensed under the the Apache-2.0 License. See the LICENSE file.
This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
