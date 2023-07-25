# Troubleshooting

If the CloudFormation stack deployment fails, use the Events tab to find the first CREATE_FAILED message.

If the CREATE_FAILED message refers to a nested stack, then find that nested stack, and navigate to the first CREATE_FAILED message. NOTE - if your stack rolled back already, the nested stacks are automatically deleted for you, so to find them change the Stacks filter from `Active` to `Deleted`.

Stacks may be nested several levels deep, so keep drilling down till you find the first resource that failed in the more deeply nested stack.

Examine the Status reason column for clues to the failure reason.

Some common failure reasons are listed below.

- _An error occurred (AccessDeniedException) when calling the SearchAvailablePhoneNumbers operation: Service is restricted for AWSAccountId XXXXXXXXXXXX_
  - Cause: Your CallAudioSource is _Demo Asterisk PBX Server_ and your AWS account has not (yet) been granted permission to allocate a Phone Number.
  - Suggested Actions:
    1. Navigate to the Amazon Chime console
    2. In the upper right, select _Support_ > _Submit Request_
    3. For Category, choose _Voice Calling_
    4. For Subject, enter _Unable to search for phone numbers with LCA_
    5. For Issue, enter _I am deploying the AWS Live Call Analytics Solution, and I am receiving this error: Exception thrown: An error occurred (AccessDeniedException) when calling the SearchAvailablePhoneNumbers operation: Service is restricted for AWSAccountId XXXXXXXXXXXX_
    6. If you are still having issues, please open an AWS Support Case by navigating to the Support Center in the AWS Management Console, and click on "Create Case".
- _An error occurred (BadRequestException) when calling the CreateVoiceConnector operation: Service received a bad request._
  - Cause: Your CallAudioSource is _Demo Asterisk PBX Server_ or _Chime VC SIPREC_ your AWS account already has 3 (max) Voice Connectors.
  - Suggested Actions:
    1. Navigate to the Amazon Chime console
    2. Choose **Voice Connectors**
    3. Check if there are already 3 existing Voice Connectors. If so, you have reached the maximum number of voice connectors. In order to create a new voice connector, you will need to delete an existing voice connector.
    4. If you have already 3 LCA stacks installed, remove one or more of them to also remove the associated voice connector. Otherwise delete unused Voice Connectors from the Chime console: see [Deleting an Amazon Chime SDK Voice Connector](https://docs.aws.amazon.com/chime-sdk/latest/ag/delete-voicecon.html)
- _You have attempted to create more buckets than allowed_
  - Cause: Your account has reached the maximum allowed limit for number of S3 buckets (default 100)
  - Suggested Actions:
    1. Empty and Delete unused buckets. Delete unused Cloudformation stacks that may have created buckets. OR
    2. Request a limit increase for number of Buckets at [ServiceQuotas](https://us-east-1.console.aws.amazon.com/servicequotas/home/services/s3/quotas)
