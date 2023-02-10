# Summarization

LCA's AI Stack supports displaying a short abstractive call transcript summarization (rendered in markdown) in addition to the extractive summarization from Transcribe Call Analytics that provides issues, action items, and outcomes.

When a call ends, LCA's Event Processor Lambda function will check to see if it has been configured for summarization. Summarization is configured by choosing an value for the `EndOfCallTranscriptSummary` CloudFormation parameter. Valid values are 
`DISABLED`, `SAGEMAKER`, and `LAMBDA`.

### **DISABLED**

This option disables call transcript summarization.

### **SAGEMAKER**

If you choose the `SAGEMAKER` option, LCA will deploy a Lambda function and  SageMaker endpoint with the [bart-large-cnn-samsum](https://huggingface.co/philschmid/bart-large-cnn-samsum) model deployed on a ml.m5.large instance. The `CallEventProcessor` Lambda will invoke a pre-configured `SummaryLambda` at the end of a call. The `SummaryLambda` will invoke the `FetchTranscript` Lambda (see more details below), to fetch a text based transcript of the call, and then sends the text to the SageMaker endpoint to generate a summary.  The summary is returned from the `SummaryLambda` to the `CallEventProcessor` and mutated/persisted to AppSync/DynamoDB.

### **LAMBDA**

If you choose the `LAMBDA` option, you must provide the Arn of your custom Lambda function in the `EndOfCallLambdaHookFunctionArn` CloudFormation parameter. At the end of a call, the `CallEventProcessor` Lambda function will invoke the custom Lambda and pass in the CallId of the call.

The custom Lambda function must return the summary in the following format:

```
{
  "summary": "Summary of the call here."
}
```

If the custom Lambda fails, or you do not want to return a summary for the call, return an empty string for the value of the summary.

## FetchTranscript Utility Lambda

The `SAGEMAKER` option for transcript summarization uses a Lambda function called `FetchTranscript` to return a string that contains the entire transcript. You can utilize this Lambda function to build custom summarization and other transcript processing tasks.

The `FetchTranscript` Lambda function accepts 3 parameters:

**CallId** (required, string) - This is the Call ID of the call to look up the transcripts for.

**ProcessTranscript** (optional, bool) - If true, the transcript will condense sequential speaker utterances into a single utterance, remove filler words (uhh, uhm), and remove any HTML that was added to the transcript. 

**TokenCount** (optional) - If this number is provided or greater than zero, the FetchTranscript function will trim the summary to this number of tokens. Tokens are words, punctuation, and new lines.

Example Lambda event payload:

```
{
      "CallId": "2359fb61-f612-4fe9-bce2-839061c328f9",
      "TokenCount": 1024,
      "ProcessTranscript": True
  }
```

