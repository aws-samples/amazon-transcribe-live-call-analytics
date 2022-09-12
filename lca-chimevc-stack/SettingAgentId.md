# Setting the AgentId field for a call

## Overview

LCA v0.5.0 and later offers the option to identify an agent for a call.   

You provide your own custom logic for retrieving the agent identifier from your contact center / IVR platform.  
Either:
1. Assign agent ID when the call starts, OR
2. Assign agent ID after the call has started

## Assign agent ID when call starts

If known, the AgentID can be provided when the call is started using a ChimeVC CallTranscriber Lambda Hook function - see [./LambdaHookFunction.md](./LambdaHookFunction.md). Your Lambda hook function might retrieve the Agent identifier from the SIPREC invite headers, or (more likely) it might interact with your IVR or some other external system that associates agent with CallId. 

## Assign agent ID after the call has started

You can send an UPDATE_AGENT event to LCA at any time after the call has started transcribing. Use the Amazon Kinesis SDK to send UPDATE_AGENT events to the Kinesis Stream identified by the LCA stack output parameter **CallDataStreamArn**.  

An UPDATE_AGENT message looks like this:
```
      {
        "CallId": <string>,
        "AgentId": <string>,
        "EventType": "UPDATE_AGENT",
      }
```

**Reference implementation:** The LCA repo contains a Lambda function that sends UPDATE_AGENT messages when using **Amazon Connect ContactLens** as the call audio source. This function subscribes to CONNECTED_TO_AGENT [contact events](https://docs.aws.amazon.com/connect/latest/adminguide/contact-events.html) from Amazon Connect, checks that they map to a callId known to LCA, retrieves the Agent name, and then builds and sends the UPDATE_AGENT message via Kinesis, informing LCA to update the AgentId field shown for the call in the UI.  Use this sample function as a reference when building your own function that integrates with your IVR to send UPDATE_AGENT events to LCA. The code is defined in the Lambda function resource named `ContactEventProcessorFunction` in the [lca-connect-integration-stack template.yaml](../lca-connect-integration-stack/template.yaml).
