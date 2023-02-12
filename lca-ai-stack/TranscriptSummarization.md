# Transcript Summarization (Experimental Feature)

LCA can now generate and display a short abstractive call transcript summary (rendered in markdown) in addition to the existing extractive summarization from Transcribe Call Analytics. 

Currently the transcript summarization feature is 'experimental'. In later releases we may adopt different techniques and add capabilities based on feedback from early adoption. We encourage experimentation, and feedback!
  
Example Transcript Summary:
   
![TranscriptSummary](./images/TranscriptSummary.png)
   
Transcript Summaries are generated after the call has ended, and can take 20-30 seconds to appear on the UI.

Configure Transcript Summarization by choosing a value for the `EndOfCallTranscriptSummary` CloudFormation parameter when deploying or updating your LCA stack. Valid values are 
`DISABLED`, `SAGEMAKER`, and `LAMBDA`.

### **DISABLED** (default)

This option (default) disables call transcript summarization.

### **SAGEMAKER**

Choose the `SAGEMAKER` option to deploy a Lambda function and a SageMaker endpoint with the [bart-large-cnn-samsum](https://huggingface.co/philschmid/bart-large-cnn-samsum) model. 

By default a 1-node ml.m5.xlarge endpoint is provisioned. For high call volume deployments, add additional nodes by increasing the parameter `SummarizationSageMakerInitialInstanceCount`. Please check [SageMaker pricing documentation](https://aws.amazon.com/sagemaker/pricing/) for relevant costs and information on Free Tier eligibility. (We have not yet tested summarization with high call volumes, so we don't yet have any scaling guidance. Please experiment and share your feedback.) 
  
By setting the parameter `SummarizationSageMakerInitialInstanceCount` to `0`, a [Serverless SageMaker endpoint](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html) is enabled. A serverless endpoint can save you money by scaling down to zero when not in use, however, there is a 'cold start' time of approximately 1-2 minutes which can delay the availability of the summary when used after a period of inactivity. LCA creates the serverless endpoint with default 4GB model memory, and max concurrency of 50 requests.  

The `CallEventProcessor` Lambda invokes a `SummaryLambda` function at the end of a call. The `SummaryLambda` in turn invokes the `FetchTranscript` Lambda (see more details below) to fetch the full transcript of the call from the DynamoDB table. The transcript is then passed to the SageMaker endpoint to generate a summary.  The summary is returned from the `SummaryLambda` to the `CallEventProcessor`, mutated and persisted to AppSync/DynamoDB, and displayed in the Call Detail page for the call in the LCA UI, as shown above.

NOTES: 
- The summarization model used in this release limits the input text length to 1024 'tokens'. Tokens are words, punctuation, and new lines. Transcripts that are longer that 1024 tokens are automatically truncated to 1024 tokens by the `FetchTranscript` lambda to avoid errors when summarizing. This, unfortunately, reduces the accuracy of the summary for long calls. We hope to be able to increase this limit by adopting newer models in future releases.
- The summarization model used in this release was trained and tested in **English** only. We hope to support additional languages in future releases.

### **LAMBDA**

Use the LAMBDA option to provide your own summarization functions and/or machine learning models. This option allows you to experiment with different models and techniques to customize the summary as you need.

When you choose the `LAMBDA` option, you must provide the Arn of your custom Lambda function in the `EndOfCallLambdaHookFunctionArn` CloudFormation parameter. At the end of a call, the `CallEventProcessor` Lambda function will invoke the custom Lambda and pass in the CallId of the call.

Your custom Lambda function must return the summary in the following JSON format:

```
{
  "summary": "Summary of the call here."
}
```

The summary can optionally use Markdown syntax to include rich text, hyperlinks, images, media, etc.

Here is a minimal example of a valid custom summarization Lambda function, written in Python. 
```
import json

def lambda_handler(event, context):
    print(json.dumps(event))
    summary = "Placeholder for actual summary" 
    # call your own model, APIs, or summarization functions here...
    return {
      "summary": summary
    }
``` 

This example function trivially returns a hardcoded string as the summary. Your function will be much smarter, and will implement your custom rules or models.
  
Use the provided [FetchTranscript utility Lambda function ](./FetchTranscriptLambda.md) in your custom summarization Lambda to retrieve the call transcript, optionally truncated to the maximum input token limit imposed by your summarization model.

Use the provided SageMaker based `SummaryLambda` function as a reference for creating your own. The function is defined as resource `SummaryLambda` in the CloudFormation template [sagemaker-summary-stack.yaml](./ml-stacks/sagemaker-summary-stack.yaml).

If your custom Lambda fails at runtime, or you do not want to return a summary for the call, return an empty string for the value of the summary field.

## FetchTranscript Utility Lambda

See [FetchTranscriptLambda.md](./FetchTranscriptLambda.md)