# Using a Lambda function to optionally provide custom logic for call handling

## Overview

LCA v0.5.0 and later offers optional custom logic via a user-provided Lambda function, to support the following features:
1. Selectively choose whether to process a call, or to ignore it
2. Reverse the default assignment of caller and agent audio streams
3. Assign an Agent identifier string for display, search, and sort on the LCA UI.  
   *NOTE see [SettingAgentId.md](./SettingAgentId.md) if you need to provide an AgentID after the call has started.*
4. Override the default CallId with another unique value for the call
5. Override the default toNumber (System Phone number)
6. Override the default fromNumber (Caller Phone number)

To use this feature:
1. Implement a Lambda function with the desired business logic
2. Use CloudFormation to register the Lambda with your LCA stack

## Lambda function requirements

Your Lambda function will be invoked by the LCA ChimeVC CallTranscriber function when both agent and caller streams for a new call are received. The full call START event for the caller stream (isCaller=true) from ChimeVC, which includes the SIPREC invite headers, is passed as the input event to your Lambda. 

Your Lambda implements your required business logic, and returns a simple JSON structure with one or more of the fields shown below:
```
         {
            originalCallId: <string>,
            shouldProcessCall: <boolean>,
            isCaller: <boolean>,
            callId: <string>,
            agentId: <string>,
            fromNumber: <string>,
            toNumber: <string>
          }
``` 
Here is a minimal example of a valid custom Lambda hook function, written in node.js
```
exports.handler = async (event) => {
    console.log(JSON.stringify(event))
    const response = {
            originalCallId: event.detail.callId,
            shouldProcessCall: true,
            isCaller: false,
            callId: `MODIFIED-${event.detail.callId}`,
            agentId: "Bob the Builder",
            fromNumber: "Bob's cell",
            toNumber: "Demo Asterisk"
          }
    return response;
};
``` 
This minimal function:
- logs the entire incoming event to the CloudWatch log stream for the function.
- swaps the agent and caller channels, by setting `isCaller` to `false`.
- modifies the original callId by adding a (hardcoded) prefix.
- assigns a (hardcoded) agentId to the call
- replaces the `fromNumber` value with a (hardcoded) string
- replaces the `toNumber` value with a (hardcoded) string

Your function will be much smarter, possibly interacting with your IVR or CRM to determine the desired behavior.

The LCA ChimeVC CallTranscriber function calls your Lambda syncronously, wiating for a valid response. If your Lambda fails or times out before completing, the CallTranscriber Lambda throws an exception, and exits without processing the call.

If your function provides a valid response, the LCA ChimeVC CallTranscriber processes each field in the response. Use the CallTranscriber CloudWatch logs to see messages that indicate the actions taken based on your function's response, for example:
```
INFO Invoking LambdaHook: arn:aws:lambda:us-east-1:XXXXXXXXXXXX:function:testLambdaHook
INFO LambdaHook response: {"originalCallId":"cfaafd64-0eed-4fdd-9699-321b6ce14d54","shouldProcessCall":true,"isCaller":false,"callId":...
INFO Lambda hook returned shouldProcessCall=true, continuing.
INFO Lambda hook returned new callId: "MODIFIED-cfaafd64-0eed-4fdd-9699-321b6ce14d54"
INFO Lambda hook returned isCaller=false, swapping caller/agent streams
INFO Lambda hook returned agentId: "Bob the Builder"
INFO Lambda hook returned fromNumber: "Bob's cell"
INFO Lambda hook returned toNumber: "Demo Asterisk"
```

If your function response sets `shouldProcessCall` to `false` the CallTranscriber function logs a message and exits without processing the call. No other response fields matter in this case.

## Register the Lambda function with LCA

Use the LCA CloudFormation template parameter **Lambda function ARN for SIPREC (existing)** to set the ARN value for your custom Lambda hook function when ceating a new LCA stack, or when updating an existing one. You find the ARN for your Lambda in the AWS Lambda console - it has this format:
```
arn:aws:lambda:us-east-1:<accountId>:function:<functionName>
```



