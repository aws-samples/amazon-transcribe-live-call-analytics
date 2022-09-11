# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2022-09-11
### Added
- AgentID call attribute and associated API support for setting, displaying, sorting, and filtering calls by Agent. See [Setting AgentId](./lca-chimevc-stack/SettingAgentId.md).
- AgentId field automatically assigned from Amazon Connect contact events when using `Amazon Connect Contact Lens` as the Call Audo Source.
- Support for custom logic via a user provided Lambda function to selectively choose which calls to process, toggle agent/caller streams, assign AgentId to call, and/or modify values for CallId and displayed phone numbers. See [Lambda Hook Function for SIPREC Call Initialization](./lca-chimevc-stack/LambdaHookFunction.md).
- Configurable retention period for call records (default 90 days). Records and transcripts that are older than this number of days are permanently deleted.
- UI supports new 'Load: 2 hrs' option for improved performance in high volume contact centers.
### Changed
- Moved transcriber Lambda out of AI stack and into ChimeVC stack.
- Remove code for call event stream processing lambda no longer used since LCA v0.4.0.
- Rename TranscriptProcessorLambda to CallEventProcessorLambda to reflect that it will process call analytics and contact metadata events in addition to transcripts.
- Rename lca-ai-stack CF template.
- Asterisk demo server reinstalled on instance reboot such as during stack updates containing Asterisk configuration or version changes.
- Asterisk demo installation script is no longer dependent on hardcoded Asterisk version.
- Asterisk demo server is reloaded each hour to resolve observed busy tones in previous releases.
- Default Asterisk demo server version is now v19.
- DynamoDB event sourcing table now maintains only one item per transcript segment and no longer maintains partial segments.
- ChimeVC CallTranscriber Lambda function now emits one Call START event when both call streams are ready (as opposed to one per call stream), eliminating 'item already exists' errors in the CallEventProcessorLambda lambda
- ChimeVC CallTranscriber Lambda function memory footprint reduced to 768MB to improve cost efficiency with minimal latency tradeoff.
- README updates

## [0.4.1] - 2022-07-15
### Changed
- Remove E.164 type enforcement on CustomerPhoneNumber and SystemPhoneNumber. Any string value is now allowed, enabling calls to be processed when either/both CustomerPhoneNumber and SystemPhoneNumber fields are non E.164 strings.

## [0.4.0] - 2022-07-15
### Added
- Introducing support for real time Agent Assist features - see [Agent Assist README](lca-agentassist-setup-stack/README.md). 
- Added support for Amazon Connect Contact Lens as an optional call source - see [Amazon Connect Integration README](/lca-connect-integration-stack/README.md) 
### Changed
- Latest Asterisk version (18) for demo PBX
- Solution title is now "Live Call Analytics with Agent Assist"

## [0.3.0] - 2022-05-18
### Added
- Support for [Genesys AudioHook](https://help.mypurecloud.com/articles/audiohook-integration-overview/). You can now
  stream call audio into the Live Call Analytics solution from a Genesys AudioHook. See the details in the
  [README](https://github.com/aws-samples/amazon-transcribe-live-call-analytics/blob/main/lca-genesys-audiohook-stack/README.md)
  file
### Changed
- Changed the audio stream consumer and transcriber component to run on AWS Lambda instead of AWS Fargate. This new Call
  Transcriber provides the following benefits:
    * Reduced Amazon Transcribe processing cost. The agent and caller audio streams are now automatically merged into a
      single stereo stream.  Both the agent and caller audio streams are transcribed in a single session
    * Longer call duration handling. The Fargate consumer had a timeout of 42 minutes. The new Lambda based transcriber
      has a mechanism that allows to transparently handoff the call processing from one Lambda invocation to another
    * Faster scaling on sudden call volume spikes
    * Simplified stereo recording process. The stereo recordings are now produced by the Call Transcriber instead of
      merging recording files after the call was done
    * Serverless!
- Additional language support
- The Call Event Stream Processor Lambda function now runs on the arm64 architecture. The new Call Transcriber Lambda
  function also runs on arm64. The build was updated to enable arm64 emulation when using the SAM CLI in Amazon Linux 2
- Partial transcript events are now only persisted for 1 day in DynamoDB. Final transcript events are persisted for 90
  days by default
- Separated the build and development python virtual environments to avoid development dependencies interfere with the
  SAM CLI
- Updated the Python GraphQL client in the Call Event Stream Processor Lambda function to the released stable version
  [gql v3.2.0](https://github.com/graphql-python/gql/releases/tag/v3.2.0). This version is now out of pre-release which
  removed the need for the Makefile based SAM CLI build of the Lambda layer. The library also added direct support for
  AppSync which removed the need for the custom AppSync transport and authentication code. The Makefile build and custom
  AppSync code has been deleted
- Updated dependency versions of various components including:
    - Web UI
    - Call Event Processor Lambda function
    - Project build and development
- Updated nodejs and npm versions used in CodeBuild to build the UI
- Fixed demo agent recording download issue
### Removed
- The resources associated with the Fargate consumer such as Fargate cluster/service/task definition, VPC, SQS queues
  and autoscaling were removed in favor of the new Lambda based Call Transcriber
- The resources associated with the creation of post call stereo recordings (including Lambda functions, S3 bucket and
  SQS queue) were removed in favor of the new Call Transcriber that merges the audio into stereo recordings at call time

## [0.2.1] - 2022-02-02
### Fixed
- Fixed semantic version in main cloudformation template

## [0.2.0] - 2022-02-02
### Added
- Added script to update semantic versions in source files. `scripts/update-version.sh`
- Added TROUBLESHOOTING.md for instructions on how to check for errors
- Added web UI admin user creation via CloudFormation. The email address of the admin user is
  passed via the `AdminEmail` CloudFormation parameter. An initial temporary password is
  automatically sent to this user via email. This email also includes the link to the web UI
- Added CloudFormation parameter to enable or disable Sentiment Analysis. See the
  `IsSentimentAnalysisEnabled` parameter
- Added CloudFormation mapping to configure the Amazon Comprehend language from the selected Amazon
  Transcribe language
- Added support to select the Spanish language (es-US) in the CloudFormation template. The
  CloudFormation template now allows to select either English (en-US) or Spanish (es-US) using the
  `TranscribeLanguageCode` parameter. **NOTE:** Content redaction is only available when using the
  English language (en-US). It is automatically disabled when using other languages
- Added the `CloudFrontAllowedGeos` CloudFormation parameter to control the CloudFront geographic
  restrictions. You can specify a comma separated list of two letter country codes (uppercase ISO
  3166-1) that are allowed to access the web user interface via CloudFront. For example: US,CA.
  Leave empty if you do not want geo restrictions to be applied
### Changed
- The CloudFormation `AllowedSignUpEmailDomain` parameter is now optional. If left empty, signup
  via the web UI is disabled and users will have to be created using Cognito. If you configure a
  domain, **only** email addresses from that domain will be allowed to signup and signin via the
  web UI
- The CloudFront distribution now defaults to no geographic restrictions. There's a new parameter
  named `CloudFrontAllowedGeos` that allows you to add geographic restrictions. If you leave this
  parameter empty, the previous geographic restriction will be removed on an update to this version.
  The previous version had a hardcoded value that set the restriction to `US` only. Set the
  `CloudFrontAllowedGeos` to `US` if you want to preserve the previous default configuration after
  updating to this version
### Fixed
- Reverted kvs stream parser library version workaround
- Asterisk server will wait for voice connector to get a phone number before initializing

## [0.1.0] - 2021-12-16
### Added
- Initial release

[Unreleased]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.5.0...develop
[0.5.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/releases/tag/v0.1.0
