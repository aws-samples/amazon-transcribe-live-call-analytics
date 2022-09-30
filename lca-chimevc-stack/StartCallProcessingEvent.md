# Start call processing for a in-progress call

## Overview

A ChimeVC CallTranscriber Lambda Hook function can disable immediate processing of a call - see `shouldProcessCall` in [LambdaHookFunction.md](./LambdaHookFunction.md).
  
To start processing such a disabled call later, while it is still in progress, send a `START_CALL_PROCESSING` event. 
  
You might want to do this if your contact center SBC initiates a SIPREC session at the start of each call, but you don't want to start transcribing the call until later, when the caller and agent are connected.  In such cases, use a ChimeVC CallTranscriber Lambda Hook function to set `shouldProcessCall` to `false`, and then later, when the IVR connects agent and caller, send a `START_CALL_PROCESSING` event to instruct the LCA Chime CallTranscriber function to start processing the call from that point in time.

You can optionally use the `START_CALL_PROCESSING` event to assign an AgentId to the call, or to change the default toNumber (System Phone Number) or fromNumber (Caller Phone Number) values assigned to the call.


## How to send a START_CALL_PROCESSING event

Use the Amazon EventBridge API to send an event with the following fields:

```
   {
      "detail-type": "START_CALL_PROCESSING",
      "source": "lca-solution",
      "detail": {
         "callId": <string - required>,
         "agentId": <string - optional>,
         "toNumber": <string - optional>,
         "fromNumber": <string - optional>
      }
   }
```

You must use the values shown above for `detail-type` (*START_CALL_PROCESSING*) and `source` (*lca-solution*).   

In the `detail` object, you must provide the callId for an in-progress call. If you used your custom call initialization Lambda Hook function to change the default callId to a new value, you must use that new value here.

Optionally, specify `agentId`, `toNumber`, or `fromNumber` to assign the desired values to these call metadata fields in LCA.

Here is an example minimal test script to send a START_CALL_PROCESSING using the AWS Python boto3 SDK:

```
import boto3
import json
client = boto3.client('events')
response = client.put_events(
    Entries=[
        {
            'Source': "lca-solution",
            'DetailType': "START_CALL_PROCESSING",
            'Detail': json.dumps({
                'callId': "Your-CallId-Here",
                'agentId': "Bob the Builder",
                'toNumber': "Contact Center Number",
                'fromNumber': 'Bobs cell'
            }),
        }
    ]
)
```

## Logs

Use the CallTranscriber CloudWatch logs to see messages that indicate receipt of the START_CALL_PROCESSING event, for example:
```
INFO Event: {"version":"0","id":"b4ec7334-3d4d-ad3a-84e8-cf19a172ab7f","detail-type":"START_CALL_PROCESSING",...
INFO START_CALL_PROCESSING event received, Retrieving previously stored callData.
INFO GetItem params: {"Key":{"PK":{"S":"cd#call-8"},"SK":{"S":"BOTH"}},"TableName":"LCA-AA-Asterisk-CHIMEVCSTACK-Q5B...
INFO GetItem result: {"$metadata":{"httpStatusCode":200,"requestId":"PCEMJ780GJA2UFBC6B6SB3F4T7VV4KQN...
INFO Write callData to DDB
INFO { TableName: 'LCA-AA-Asterisk-CHIMEVCSTACK-Q5B3LOV32VYX-DeployCallTranscriber-K0KRQLW8E9N5-Transcrib...
INFO START_CALL_PROCESSING event contains agentId: "BOB!"
INFO START_CALL_PROCESSING event contains fromNumber: "New IVR number"
INFO START_CALL_PROCESSING event contains toNumber: "New CallerID"
INFO Write callData to DDB
INFO { TableName: 'LCA-AA-Asterisk-CHIMEVCSTACK-Q5B3LOV32VYX-DeployCallTranscriber-K0KRQLW8E9N5-TranscriberCallEventTable...
INFO Ready to start processing call
```

The CallTranscriber Lambda function also saves call metadata in a DynamoDB table. The table name has
the following pattern: *LCAStackName*-CHIMEVCSTACK-*NNNN*-DeployCallTransriber-*NNNN*-TranscriberCallEventTable-*NNNN*.  Explore items in this table using DynamoDB console **Explore items**. Call metadata items have a Partition Key (**PK**) of the form `cd#<callId>`.  All items in this table are retained for 1 day only.


