# Troubleshooting

### If the CloudFormation stack deployment fails, and you are deploying with the Demo Asterisk Server:

1. In the AWS Management Console, navigate to the CloudWatch service, then CloudWatch Logs.
2. Search for a log group that contains your stack name, appended with CHIMEVCSTACK, for example, */aws/lambda/LiveCallAnalytics-CHIMEVCSTACK-XXXX-createLambdaVC-XXXXXXXXXXXX*, and click it.
3. Click the log stream to view its contents.
4. Search for the word *error* in the search bar.
5. If you find an error, and the error message says: *Exception thrown: An error occurred (AccessDeniedException) when calling the SearchAvailablePhoneNumbers operation: Service is restricted for AWSAccountId XXXXXXXXXXXX*
   1. Navigate to the Amazon Chime console
   2. In the upper right, select *Support* > *Submit Request*
   3. For Category, choose *Voice Calling*
   4. For Subject, enter *Unable to search for phone numbers with LCA*
   5. For Issue, enter *I am deploying the AWS Live Call Analytics Solution, and I am receiving this error: Exception thrown: An error occurred (AccessDeniedException) when calling the SearchAvailablePhoneNumbers operation: Service is restricted for AWSAccountId XXXXXXXXXXXX*
6. If you are still having issues, please open an AWS Support Case by navigating to the Support Center in the AWS Management Console, and click on "Create Case". 