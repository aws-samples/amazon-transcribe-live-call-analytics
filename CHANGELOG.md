# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.2.1...develop
[0.2.1]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/aws-samples/amazon-transcribe-live-call-analytics/releases/tag/v0.1.0
