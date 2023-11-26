# Amazon Connect Kinesis Video Streams Audio Source

Amazon Connect supports [media streaming](https://docs.aws.amazon.com/connect/latest/adminguide/customer-voice-streams.html) via Amazon Kinesis Video Streams, similar to how Amazon Chime SDK Voice Connector works. 

### How to enable:

1. Follow the instructions in the [plan for live media streaming in Amazon Connect](https://docs.aws.amazon.com/connect/latest/adminguide/plan-live-media-streams.html) page.
2. Follow the instructions in the [enable live media streaming in Amazon Connect](https://docs.aws.amazon.com/connect/latest/adminguide/enable-live-media-streams.html) page.
3. Add the KVS Consumer Lambda function in Connect. 
- Navigate to the outputs of the Live Call Analytics stack from CloudFormation and find the `StartLCAFunctionName` parameter. 
- Within the AWS Management Console, navigate to Amazon Connect. Select your connect instance.
- Navigate to Flows > AWS Lambda. Under Lambda Functions, choose the `StartLCAFunctionName` Lambda Function name. Select **+Add Lambda Function**.

4. Create a contact flow that [uses the media streams blocks](https://docs.aws.amazon.com/connect/latest/adminguide/use-media-streams-blocks.html). THe goal of the contact flow is to enable media streaming and invoke the **StartLCAFunction**. You can do this either at the beginning of your contact flow.
An example contact flow can be [downloaded here](./lca-contact-flow.json).