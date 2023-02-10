# Summarization

LCA's AI Stack supports displaying a short abstractive call summarization (rendered in markdown) in addition to the extractive summarization from Transcribe Call Analytics that provides issues, action items, and outcomes.

The flow of how summarization works is after the call has ended, LCA's Call Event Processor Lambda function will check to see if LCA has been configured with a custom Lambda arn for summarization, and then it will call the Lambda arn.

# Sagemaker

E5-Large 

# Custom Lambda

# Utilities