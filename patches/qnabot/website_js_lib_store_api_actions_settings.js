/** *******************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/                                                                               *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 ******************************************************************************************************************** */
const _ = require('lodash');
const { SSMClient, GetParameterCommand, GetParametersCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const util = require('../../../../capability/util');

const chatbotTestingIndex = 0;
const languageSettingsIndex = 1;
const opensearchSettingsIndex = 2;
const securitySettingsIndex = 3;
const queryMatchingSettingsIndex = 4;
const settingsMap = {
    baseChatbot: {
        label: 'Base Chatbot Settings',
        openedPanels: [
            chatbotTestingIndex,
            languageSettingsIndex,
            opensearchSettingsIndex,
            securitySettingsIndex,
            queryMatchingSettingsIndex,
        ],
        subgroups: {
            chatbotTesting: {
                id: 'chatbot_testing_subgroup',
                label: 'ChatBot Testing',
                collapsed: false,
                members: [
                    {
                        id: 'ENABLE_DEBUG_RESPONSES',
                        type: 'boolean',
                        hint: 'Determines whether to log original English responses and translated responses for debugging',
                    },
                    {
                        id: 'ENABLE_DEBUG_LOGGING',
                        type: 'boolean',
                        hint: 'Controls verbosity of the QnABot Cloudwatch log. Set to true to see QnABot debug messages',
                    },
                ],
            },
            languageSettings: {
                id: 'language_identification_subgroup',
                label: 'Language Identification',
                collapsed: false,
                members: [
                    {
                        id: 'ENABLE_MULTI_LANGUAGE_SUPPORT',
                        type: 'boolean',
                        hint: 'Enable or Disable Amazon Translate support',
                    },
                    {
                        id: 'MINIMUM_CONFIDENCE_SCORE',
                        type: 'number',
                        hint: 'Enter number between 0.0 and 1.0. The minimum confidence before Amazon Comprehend will determine the user\'s language',
                    },
                ],
            },
            opensearchSettings: {
                id: 'opensearch_subgroup',
                label: 'OpenSearch',
                collapsed: false,
                members: [
                    {
                        id: 'ES_USE_KEYWORD_FILTERS',
                        type: 'boolean',
                        hint: 'Determines whether to detect keywords from Comprehend when searching for answers',
                    },
                    {
                        id: 'ES_SYNTAX_CONFIDENCE_LIMIT',
                        type: 'number',
                        hint: 'Enter number between 0.0 and 1.0. Amazon Comprehend makes a best effort to determine the parts of speech  in a sentence. The keywords will only be used if the confidence limit is greater than this amount',
                    },
                    {
                        id: 'ES_MINIMUM_SHOULD_MATCH',
                        hint: 'See https://opensearch.org/docs/latest/query-dsl/minimum-should-match/ for syntax.  Determines how close a question should match to return a hit',
                    },
                    {
                        id: 'ES_SCORE_ANSWER_FIELD',
                        type: 'boolean',
                        hint: 'Search the content of the answer field as a 2nd pass query (if there\'s no good match from 1st pass query on question fields)',
                    },
                    {
                        id: 'ES_SCORE_TEXT_ITEM_PASSAGES',
                        type: 'boolean',
                        hint: 'If no \'qna\' answer meets the score threshold, then query the text field of \'text\' items',
                    },
                    {
                        id: 'ERRORMESSAGE',
                        hint: 'Response to the user when a processing error occurs',
                    },
                    {
                        id: 'EMPTYMESSAGE',
                        hint: 'Response to the user when an answer could not be found',
                    },
                ],
            },
            securitySettings: {
                id: 'security_and_privacy_subgroup',
                label: 'Security and Privacy',
                collapsed: false,
                members: [
                    {
                        id: 'IDENTITY_PROVIDER_JWKS_URLS',
                        hint: 'Enter a comma-delimited list of URLs. Adds trusted IdPs (e.g. from Lex-Web-UI CognitoUserPoolPubKey)',
                    },
                    {
                        id: 'ENFORCE_VERIFIED_IDENTITY',
                        type: 'boolean',
                        hint: 'Set to true to make QnABot require verified identity from client',
                    },
                    {
                        id: 'NO_VERIFIED_IDENTITY_QUESTION',
                        hint: 'If user identity cannot be verified, replace question string with this',
                    },
                    {
                        id: 'ENABLE_REDACTING',
                        type: 'boolean',
                        hint: 'Enable the system to redact log output',
                    },
                    {
                        id: 'REDACTING_REGEX',
                        hint: 'Enter a regular expression. Redacts expressions matching regex from logs',
                    },
                    {
                        id: 'ENABLE_REDACTING_WITH_COMPREHEND',
                        type: 'boolean',
                        hint: 'Enables Amazon Comprehend based PII Redacting. See: https://aws.amazon.com/blogs/machine-learning/detecting-and-redacting-pii-using-amazon-comprehend/',
                    },
                    {
                        id: 'COMPREHEND_REDACTING_CONFIDENCE_SCORE',
                        type: 'number',
                        hint: 'Enter a number between 0.0 and 1.0. Only redact PII where Amazon Comprehend\'s confidence score is greater than this number',
                    },
                    {
                        id: 'COMPREHEND_REDACTING_ENTITY_TYPES',
                        hint: 'Enter a comma-separated list of values. A list of PII Entity Types. See: https://aws.amazon.com/blogs/machine-learning/detecting-and-redacting-pii-using-amazon-comprehend/',
                    },
                    {
                        id: 'PII_REJECTION_ENABLED',
                        type: 'boolean',
                        hint: 'Enables PII Rejection',
                    },
                    {
                        id: 'PII_REJECTION_QUESTION',
                        hint: 'If PII is found, the user\'s request (question) will change to this phrase',
                    },
                    {
                        id: 'PII_REJECTION_REGEX',
                        hint: 'Enter a regular expression. Used to find PII based on a regex',
                    },
                    {
                        id: 'PII_REJECTION_ENTITY_TYPES',
                        hint: 'Enter a comma separated list of PII Entity Categories (https://aws.amazon.com/blogs/machine-learning/detecting-and-redacting-pii-using-amazon-comprehend/). Only recognize PII entity types in the list',
                    },
                    {
                        id: 'PII_REJECTION_CONFIDENCE_SCORE',
                        type: 'number',
                        hint: 'Enter a number between 0.0 and 1.0. Only reject PII where Amazon Comprehend\'s confidence score is greater than this number',
                    },
                    {
                        id: 'DISABLE_CLOUDWATCH_LOGGING',
                        type: 'boolean',
                        hint: 'Disable all logging in fulfillment es query handler lambda. does not disable logging from Lambda Hooks or Conditional Chaining Lambda functions',
                    },
                    {
                        id: 'MINIMAL_ES_LOGGING',
                        type: 'boolean',
                        hint: 'Set to true to not log utterances or session attributes to OpenSearch for OpenSearchDashboards logging',
                    },
                    {
                        id: 'S3_PUT_REQUEST_ENCRYPTION',
                        hint: 'Enable header x-amz-server-side-encryption header and set with this value',
                    },
                ],
            },
            queryMatchingSettings: {
                id: 'query_matching_subgroup',
                label: 'Query Matching',
                collapsed: false,
                members: [
                    {
                        id: 'SEARCH_REPLACE_QUESTION_SUBSTRINGS',
                        hint: 'replace words or phrases in user questions by defining search/replace pairs in a JSON object like: {"searchString":"replaceString"}. Add additional pairs separated by commas, like: {"searchString":"replaceString", "searchString2":"replaceString2"}',
                    },
                    {
                        id: 'PROTECTED_UTTERANCES',
                        hint: 'A comma-separated list of utterances that will not be translated or disambiguated by QnABot. Each phrase is not case sensitive and ignores common punctuation characters: .,!;-?',
                    },
                    {
                        id: 'EMBEDDINGS_ENABLE',
                        type: 'boolean',
                        hint: 'Disable use of semantic search using embeddings. Set to TRUE only if QnABot stack was deployed with embeddings enabled',
                    },
                    {
                        id: 'EMBEDDINGS_SCORE_THRESHOLD',
                        type: 'number',
                        hint: 'Enter a number between 0.0 and 1.0. If embedding similarity score is under threshold the match is rejected and QnABot reverts to scoring answer field (if ES_SCORE_ANSWER_FIELD is true)',
                    },
                    {
                        id: 'EMBEDDINGS_SCORE_ANSWER_THRESHOLD',
                        type: 'number',
                        hint: 'Enter a number between 0.0 and 1.0. Applies only when if ES_SCORE_ANSWER_FIELD is true. If embedding similarity score on answer field is under threshold the match is rejected',
                    },
                    {
                        id: 'EMBEDDINGS_TEXT_PASSAGE_SCORE_THRESHOLD',
                        type: 'number',
                        hint: 'Enter a number between 0.0 and 1.0. Applies only when if ES_SCORE_TEXT_ITEM_PASSAGES is true. If embedding similarity score on text item field is under threshold the match is rejected',
                    },
                    {
                        id: 'LLM_GENERATE_QUERY_ENABLE',
                        type: 'boolean',
                        hint: 'Enables query disambiguation',
                    },
                    {
                        id: 'LLM_GENERATE_QUERY_PROMPT_TEMPLATE',
                        type: 'textarea',
                        hint: 'Template to send to the LLM to generate a query from',
                    },
                    {
                        id: 'LLM_GENERATE_QUERY_MODEL_PARAMS',
                        hint: 'Parameters sent to the LLM model when disambiguating follow-up questions (e.g anthropic model parameters can be customized as `{"temperature":0.1}` or `{"temperature":0.3, "max_tokens": 262, "top_k": 240, "top_p":0.9 }`). Please check LLM model documentation for values that your model provider accepts',
                    },
                ],
            },
            advancedSettings: {
                id: 'advanced_subgroup',
                label: 'Advanced',
                collapsed: true,
                members: [
                    {
                        id: 'ES_EXPAND_CONTRACTIONS',
                        hint: 'Expand contractions to resolve problems with keyword filters',
                    },
                    {
                        id: 'ES_KEYWORD_SYNTAX_TYPES',
                        hint: 'Enter comma-separated values. See https://docs.aws.amazon.com/comprehend/latest/dg/how-syntax.html. A list of tokens representing parts of speech identified by Amazon Comprehend for matching questions',
                    },
                    {
                        id: 'ES_NO_HITS_QUESTION',
                        hint: 'The question QnABot should use when it cannot find an answer',
                    },
                    {
                        id: 'ES_ERROR_QUESTION',
                        hint: 'The question QnABot should use when a backend error ocurred',
                    },
                    {
                        id: 'ES_USE_FUZZY_MATCH',
                        type: 'boolean',
                        hint: 'Determines whether QnABot should return answers similar to the question asked. See https://opensearch.org/docs/latest/query-dsl/term/fuzzy/ for more information',
                    },
                    {
                        id: 'ES_PHRASE_BOOST',
                        type: 'number',
                        hint: 'If the user\'s question is a phrase match to a question in the knowledge then boost the score by this factor',
                    },
                    {
                        id: 'ENABLE_SENTIMENT_SUPPORT',
                        type: 'boolean',
                        hint: 'Enables Amazon Comprehend be used for sentiment analysis. See: https://docs.aws.amazon.com/comprehend/latest/dg/how-sentiment.html',
                    },
                    {
                        id: 'ENABLE_CUSTOM_TERMINOLOGY',
                        type: 'boolean',
                        hint: 'Enable support for installed Custom Terminology files when using Amazon Translate. See: https://aws.amazon.com/blogs/machine-learning/introducing-amazon-translate-custom-terminology/',
                    },
                    {
                        id: 'ALT_SEARCH_KENDRA_FAQ_CONFIDENCE_SCORE',
                        type: 'enum',
                        enums: ['VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW'],
                        hint: 'Minimum Kendra confidence level threshold for Kendra FAQ. See: https://aws.amazon.com/about-aws/whats-new/2020/09/amazon-kendra-launches-confidence-scores/',
                    },
                    {
                        id: 'ALT_SEARCH_KENDRA_FAQ_MESSAGE',
                        hint: 'Heading when a Frequently Asked Question is found by Amazon Kendra.- See: https://docs.aws.amazon.com/kendra/latest/dg/response-types.html',
                    },
                    {
                        id: 'KENDRA_FAQ_CONFIG_MAX_RETRIES',
                        type: 'number',
                        hint: 'Number of times to retry syncing FAQ\'s when a throttling error occurs',
                    },
                    {
                        id: 'KENDRA_FAQ_CONFIG_RETRY_DELAY',
                        type: 'number',
                        hint: 'Amount of time to wait in seconds between attempts to retry syncing',
                    },
                    {
                        id: 'KENDRA_FAQ_ES_FALLBACK',
                        type: 'boolean',
                        hint: 'When Kendra FAQ is enabled, but does not return an answer then query OpenSearch',
                    },
                    {
                        id: 'ENABLE_KENDRA_WEB_INDEXER',
                        type: 'boolean',
                        hint: 'Enables the web indexer',
                    },
                    {
                        id: 'KENDRA_INDEXER_URLS',
                        hint: 'Enter comma-separated values. List of web addresses QnABot should crawl and index with Kendra',
                    },
                    {
                        id: 'KENDRA_INDEXER_CRAWL_DEPTH',
                        type: 'number',
                        hint: 'Sets the depth to the number of levels in a website from the seed level that you want to crawl',
                    },
                    {
                        id: 'KENDRA_INDEXER_CRAWL_MODE',
                        type: 'enum',
                        enums: ['HOST_ONLY', 'SUBDOMAINS', 'EVERYTHING'],
                        hint: 'Determines which addresses should be crawled',
                    },
                    {
                        id: 'KENDRA_INDEXER_SCHEDULE',
                        hint: 'See https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/ScheduledEvents.html for CloudWatch Rate Syntax. Interval Indexer should crawl',
                    },
                    {
                        id: 'KENDRA_INDEXED_DOCUMENTS_LANGUAGES',
                        hint: 'Enter comma-separated values. Should be one of supported Kendra languages mentioned here: https://docs.aws.amazon.com/kendra/latest/dg/in-adding-languages.html',
                    },
                    {
                        id: 'SMS_HINT_REMINDER_ENABLE',
                        type: 'boolean',
                        hint: 'Enables SMS_HINT_REMINDER',
                    },
                    {
                        id: 'SMS_HINT_REMINDER',
                        hint: 'Reminds user how to use the bot on first use after SMS_HINT_REMINDER_INTERVAL_HRS',
                    },
                    {
                        id: 'SMS_HINT_REMINDER_INTERVAL_HRS',
                        type: 'number',
                        hint: 'The amount of time in hours when to send SMS_HINT_REMINDER',
                    },
                    {
                        id: 'RUN_LAMBDAHOOK_FROM_QUERY_STEP',
                        type: 'boolean',
                        hint: 'Controls timing of execution for Lambda hooks',
                    },
                    {
                        id: 'LAMBDA_PREPROCESS_HOOK',
                        hint: 'name of AWS Lambda to run before each question is processed. The name of the Lambda must start with "qna-" or "QNA-" to comply with the permissions of the role attached to the Fulfillment Lambda',
                    },
                    {
                        id: 'LAMBDA_POSTPROCESS_HOOK',
                        hint: 'name of AWS Lambda to run after the question is processed. But before user profile information is saved. The name of the Lambda must start with "qna-" or "QNA-" to comply with the permissions of the role attached to the Fulfillment Lambda',
                    },
                    {
                        id: 'EMBEDDINGS_MAX_TOKEN_LIMIT',
                        hint: 'Max number of tokens the embeddings model can handle',
                    },
                    {
                        id: 'LLM_PROMPT_MAX_TOKEN_LIMIT',
                        hint: 'Specifies the maximum number of tokens in the prompt message that can be sent to the LLM. QnABot will selectively truncate the prompt by history and context to shorten the total length',
                    },
                ],
            },
        },
    },
    addins: {
        label: 'Add Ins and Connections Settings',
        openedPanels: [],
        subgroups: {
            lexSettings: {
                id: 'amazon_lex_subgroup',
                label: 'Amazon Lex',
                collapsed: true,
                members: [
                    {
                        id: 'ELICIT_RESPONSE_MAX_RETRIES',
                        type: 'number',
                        hint: 'Number of times an elicitResponse LexBot can fail before QnaBot gives up and does not ask the user to start the elicitResponse LexBot workflow again',
                    },
                    {
                        id: 'ELICIT_RESPONSE_RETRY_MESSAGE',
                        hint: 'Retry message displayed by QnABot when the elicitResponse LexBot workflow fails and the user has to start again',
                    },
                    {
                        id: 'ELICIT_RESPONSE_BOT_FAILURE_MESSAGE',
                        hint: 'Failure message displayed by QnaBot when the maximum number of retries of the elicitResponse LexBot workflow is exceeded',
                    },
                    {
                        id: 'ELICIT_RESPONSE_DEFAULT_MSG',
                        hint: 'Default closing response message used by QnAbot when the elicitResponse LexBot does not return a closing response to QnABot',
                    },
                    {
                        id: 'BOT_ROUTER_WELCOME_BACK_MSG',
                        hint: 'The text used by QnABot when ending communication from a specialty bot',
                    },
                    {
                        id: 'BOT_ROUTER_EXIT_MSGS',
                        hint: 'Enter comma-separated values. The exit phrases in comma separated list available for the a user to end communication with a specialty bot',
                    },
                ],
            },
            connectSettings: {
                id: 'amazon_connect_subgroup',
                label: 'Amazon Connect',
                collapsed: true,
                members: [
                    {
                        id: 'CONNECT_IGNORE_WORDS',
                        hint: 'Throw an error if the transcript provided by connect __only__ contains the words in this list (case insensitive). This is useful if you find many missed utterances due to the use of filler words before a proper utterance (e.g. "a", "e", "umm", "like", etc.). This setting can not be used as a transcript filter (see `LAMBDA_PREPROCESS_HOOK` or `LAMBDA_POSTPROCESS_HOOK` if you wish to apply custom processing to questions/answers)',
                    },
                    {
                        id: 'CONNECT_ENABLE_VOICE_RESPONSE_INTERRUPT',
                        type: 'boolean',
                        hint: 'Return bot response in session attribute to enable contact flow to use response as an interruptible prompt',
                    },
                    {
                        id: 'CONNECT_NEXT_PROMPT_VARNAME',
                        hint: 'Name of session var to use for next prompt',
                    },
                ],
            },
            alexaSettings: {
                id: 'amazon_alexa_subgroup',
                label: 'Amazon Alexa',
                collapsed: true,
                members: [
                    {
                        id: 'DEFAULT_ALEXA_LAUNCH_MESSAGE',
                        hint: 'Initial greeting when using Alexa',
                    },
                    {
                        id: 'DEFAULT_ALEXA_REPROMPT',
                        hint: 'Default text used for Alexa reprompt capability',
                    },
                    {
                        id: 'DEFAULT_ALEXA_STOP_MESSAGE',
                        hint: 'User response to end session with Alexa',
                    },
                ],
            },
        },
    },
    rag: {
        label: 'Live Call Analytics',
        openedPanels: [],
        subgroups: {
            generalSettings: {
                id: 'lma_general_subgroup',
                label: 'General Settings',
                collapsed: true,
                members: [
                    {
                        id: 'LLM_QA_MODEL_PARAMS',
                        hint: 'Parameters sent to the LLM model when generating answers to questions (e.g. anthropic model parameters can be customized as `{"temperature":0.1}` or `{"temperature":0.3, "max_tokens": 262, "top_k": 240, "top_p":0.9 }`). Please check LLM model documentation for values that your model provider accepts',
                    },
                    {
                        id: 'LLM_QA_PREFIX_MESSAGE',
                        hint: 'Message used to prefix LLM-generated answer',
                    },
                    {
                        id: 'LLM_QA_SHOW_CONTEXT_TEXT',
                        type: 'boolean',
                        hint: 'Enables or disables inclusion of the passages used as context for LLM-generated answers',
                    },
                    {
                        id: 'LLM_QA_SHOW_SOURCE_LINKS',
                        type: 'boolean',
                        hint: 'Enables or disables Kendra Source Links or passage refMarkdown links (document references) in markdown answers',
                    },
                    {
                        id: 'LLM_CHAT_HISTORY_MAX_MESSAGES',
                        type: 'number',
                        hint: 'Specifies the maximum number of previous messages maintained in the QnABot DynamoDB UserTable for conversational context and follow-up question disambiguation',
                    },
                    {
                        id: 'ASSISTANT_NO_HITS_REGEX',
                        hint: 'Regular expression pattern to match LLM responses that indicate no hits (e.g., "Sorry, I don\'t know").',
                    },
                ],
            },
            lCAAssistant: {
                id: 'lca_prompttempate_subgroup',
                label: 'Prompt Templates',
                collapsed: false,
                members: [
                    {
                        id: 'ASSISTANT_QUERY_PROMPT_TEMPLATE',
                        type: 'textarea',
                        hint: 'LLM prompt template for creating a standalone KB search query using the meeting transcript context.',
                    },
                    {
                        id: 'ASSISTANT_GENERATE_PROMPT_TEMPLATE',
                        type: 'textarea',
                        hint: 'LLM prompt template for generating an answer to the query, using the transcript and either KB search results and/or LLM alone.',
                    },
                ],
            },
        },
    },
};


async function getParameters(ssm, params) {
    const getParametersCommand = new GetParametersCommand(params);
    try {
        const data = await ssm.send(getParametersCommand);
        const custom_settings = JSON.parse(data.Parameters[0].Value);
        const default_settings = JSON.parse(data.Parameters[1].Value);
        const cloned_default = _.clone(default_settings);
        const merged_settings = _.merge(cloned_default, custom_settings);
        const settings = [default_settings, custom_settings, merged_settings];
        return settings;
    } catch (error) {
        console.log(error, error.stack);
        throw new Error(`Error back from request: ${error}`);
    }
}

async function saveParameters(ssm, params) {
    const putParameterCommand = new PutParameterCommand(params);
    try {
        const ssmResponse = await ssm.send(putParameterCommand);
        return ssmResponse;
    } catch (error) {
        console.log(error, error.stack);
        throw new Error(`Error back from request: ${error}`);
    }
}

async function sendAnonymizedData(params, settings){
    const map = { event: 'UPDATE_SETTINGS' };
    map.BEDROCK_GUARDRAIL_ENABLE = settings.BEDROCK_GUARDRAIL_IDENTIFIER && settings.BEDROCK_GUARDRAIL_VERSION ? 'true' : 'false';
    map.ENABLE_MULTI_LANGUAGE_SUPPORT = settings.ENABLE_MULTI_LANGUAGE_SUPPORT || 'false';
    map.LLM_GENERATE_QUERY_ENABLE = settings.LLM_GENERATE_QUERY_ENABLE || 'true';
    map.KNOWLEDGE_BASE_SEARCH_TYPE = settings.KNOWLEDGE_BASE_SEARCH_TYPE || 'DEFAULT';
    map.PII_REJECTION_ENABLED = settings.PII_REJECTION_ENABLED || 'false';
    map.EMBEDDINGS_ENABLE = settings.EMBEDDINGS_ENABLE || 'true';
    map.LLM_QA_ENABLE = settings.LLM_QA_ENABLE || 'true';


    const payload = Buffer.from(JSON.stringify(map));
    const client = new LambdaClient({
        customUserAgent: util.getUserAgentString(params.version, 'C050'),
        region: params.region, 
        credentials: params.credentials
    });

    const input = {
        FunctionName: params.solutionHelper,
        InvocationType: "Event",
        Payload: payload,
    };
    const command = new InvokeCommand(input);
    const response = await client.send(command);
    if (response.FunctionError) {
        throw new Error('Solution Helper Function Error Occurred');
    }
    return response;
}

module.exports = {
    async listSettings(context) {
        const credentials = context.rootState.user.credentials;
        const customParams = context.rootState.info.CustomQnABotSettings;
        const defaultParams = context.rootState.info.DefaultQnABotSettings;
        const ssm = new SSMClient({
            customUserAgent: util.getUserAgentString(context.rootState.info.Version, 'C022'),
            region: context.rootState.info.region, credentials
        });
        const query = {
            Names: [customParams, defaultParams],
            WithDecryption: true,
        };
        const response = await getParameters(ssm, query);

        return response;
    },
    async listPrivateSettings(context) {
        const { credentials } = context.rootState.user;
        const privateSettings = context.rootState.info.PrivateQnABotSettings;
        const ssm = new SSMClient({
            customUserAgent: util.getUserAgentString(context.rootState.info.Version, 'C022'),
            region: context.rootState.info.region,
            credentials,
        });
        try {
            const getParameterCommand = new GetParameterCommand({
                Name: privateSettings,
                WithDecryption: true,
            });
            const ssmResponse = await ssm.send(getParameterCommand);
            const settingsResponse = JSON.parse(ssmResponse.Parameter.Value);
            return settingsResponse;
        } catch (error) {
            console.error(`Error while fetching ssm paramter ${error}`);
            return {};
        }
    },
    async updateSettings(context, settings) {
        const credentials = context.rootState.user.credentials;
        const customParams = context.rootState.info.CustomQnABotSettings;
        const region = context.rootState.info.region;
        const version = context.rootState.info.Version;
        const solutionHelper = context.rootState.info.SolutionHelper;
        const ssm = new SSMClient({
            customUserAgent: util.getUserAgentString(version, 'C022'),
            region, 
            credentials
        });
    
        try {
            const params = {
                region,
                credentials,
                version,
                solutionHelper
            };
            await sendAnonymizedData(params, settings);
        } catch (e) {
            console.log(`Error in sending anonymized data: ${e.message}`);
        }
        
        // Note type is not required in params if the parameter exists. Some customers require this parameter
        // to be a SecureString and set this type post deploy of QnABot. Removing type supports
        // this setting.
        const params = {
            Name: customParams,
            Value: JSON.stringify(settings),
            Overwrite: true,
        };
        const response = await saveParameters(ssm, params);
        return response;
    },
    getSettingsMap() {
        return settingsMap;
    },
};
