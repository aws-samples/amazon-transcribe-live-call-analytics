# Setting the AgentId field for a call

## Overview

LCA v0.5.0 and later offers the option to identify an agent for a call.   

You provide your own custom logic for retrieving the agent identifier from your contact center / IVR platform.  
Either:
1. Assign agent ID when the call starts, OR
2. Assign agent ID after the call has started

## Assign agent name when call starts

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

LCA provides a Lambda function to send UPDATE_AGENT messages to LCA when the Call Audio Source is **Amazon Connect ContactLens**. It subscribes to Amazon Connect agent_assigned contact events via Amazon EventBridge, checks that they map to a known callId, retrieves the Agent identification using the Connect APIs, and then builds and sends the UPDATE_AGENT message to Kinesis, informing LCA to update the AgentId field shown in the UI.  
You may be able to use this sample function as a reference when building your own function to send UPDATE_AGENT events to LCA. The code is contained in the [lca-connect-integration-stack template.yaml](../lca-connect-integration-stack/template.yaml).

