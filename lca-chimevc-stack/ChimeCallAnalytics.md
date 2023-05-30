# Chime Call Analytics

LCA now includes (experimental) support for Amazon Chime Call Analytics. Amazon Chime SDK call analytics gives developers low-code solutions for generating cost-effective insights from real-time audio, including audio ingestion, analysis, alerting and data lake integration. Call analytics enables you to generate insights through integration with Amazon Transcribe and Transcribe Call Analytics (TCA), and natively through Amazon Chime SDK voice analytics.

**If enabled in the CloudFormation parameters, LCA will use Chime Call Analytics instead of the existing Call Transcriber Lambda.**

This works by using [Chime Media Insights Pipelines](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_media-pipelines-chime_CreateMediaInsightsPipeline.html) along with a [Chime Media Insights Pipeline Configuration](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_media-pipelines-chime_CreateMediaInsightsPipelineConfiguration.html) to configure a KVS source, Amazon Transcribe (or Amazon Transcribe Call Analytics) processors, and KDS sinks. 

To learn more about how LCA uses Chime Call Analytics, please read [Workflow 2: Customize call analytics usage with Voice Connector](https://docs.aws.amazon.com/chime-sdk/latest/dg/ca-workflow-2.html).

The Chime Voice Connector that is deployed with the ChimeVC stack will have its streaming configuration updated to automatically use the Media Insights Pipeline Configuration if Voice Tone is enabled. Please read more below for details.

If Voice Tone is disabled, for each new call the ChimeCallAnalyticsInitialization Lambda will be invoked when the call is started, it will call the optional Lambda Hooks, and start a Chime Media Insights Pipeline if Transcription should begin.

## Voice Tone

Chime Call Analytics also supports Voice Tone analysis. If enabled in the CloudFormation parameters, LCA will update the Chime Voice Connector's streaming configuration to use a Media Insights Pipeline Configuration. The media pipeline will be automatically launched for each new call.

If you enable Voice Tone, and you are using the [call initalization Lambda hook](https://github.com/aws-samples/amazon-transcribe-live-call-analytics/blob/develop/lca-chimevc-stack/LambdaHookFunction.md), **LCA will invoke the Lambda hook, however it will ignore the shouldProcessCall parameter**.  This is because the only way for Voice Tone to function is if the Media Insights Pipeline is invoked directly from the Chime Voice Connector (and not as a separate Chime Media Insights Pipeline workflow).

To learn more about the workflow used in conjunction with Voice Tone, please read [Workflow 1: Voice Connector initiates call analytics](https://docs.aws.amazon.com/chime-sdk/latest/dg/ca-workflow-1.html)

Enabling Voice Tone will also show a voice tone chart in the LCA user interface to the right of the existing sentiment analysis charts.

## Pausing/resuming Transcripion

For times when you would like to pause or resume an analysis/transcription, you should use the Chime [Update Media Insights Pipeline Status](https://docs.aws.amazon.com/chime-sdk/latest/APIReference/API_media-pipelines-chime_UpdateMediaInsightsPipelineStatus.html).

## Known Issues

- Call recording functionality does not work
- Post Call Analytics integration does not work
