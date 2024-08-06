# LCA Agent Assist

## Table of Contents

1. [Introduction to Agent Assist](#introduction)  
  a. [Amazon Lex and knowledge bases on Amazon Bedrock using QnABot](#amazon-lex-and-knowledge-bases-on-amazon-bedrock-using-qnabot)  
  b. [Option: Bring your own Lex Bot](#option-bring-your-own-lex-bot)  
  c. [Option: Bring your own Lambda function](#option-bring-your-own-lambda-function)  
2. [How it works](#how-it-works)  
3. [How to enable Agent Assist](#how-to-enable-agent-assist)
4. [Testing Agent Assist](#testing-agent-assist)
5. [Configuring Agent Assist Responses](#configuring-agent-assist-responses)  
  a. [Static FAQ response](#static-faq-response)  
  b. [Dynamic response](#dynamic-response)  
  ... i.  [Context aware response](#context-aware-response)  
  ... iii. [Dynamic Custom Business Logic](#dynamic-custom-business-logic)  
  c. [Knowledge Base on Amazon Bedrock Fallback Response](#amazon-bedrock-knowledge-base-fallback-response)   
  d. [Rebuild Lex Bot](#rebuild-lex-bot)   

## Introduction

Live Call Analytics with Agent Assist is a solution for contact centers, providing in-line messages to help agents respond to callers’ needs.  

Before continuing, please read the blog post [Live call analytics and agent assist for your contact center with Amazon language AI services](https://amazon.com/live-call-analytics), deploy LCA, and follow the tutorial to experience the Agent Assist demo. This is prerequisite context for the rest of this document.


### Amazon Lex and knowledge bases on Amazon Bedrock using QnABot

The default agent assist configuration works by sending the transcription of a caller’s utterances to a chatbot, powered by Amazon Lex and an knowledge bases on Amazon Bedrock, using the [QnABot on AWS solution](https://aws.amazon.com/solutions/implementations/aws-qnabot/) to simplify configuration and orchestration. Lex tracks the callers' intents and can advise the agent to elicit additional information as needed to fulfil an intent, QnABot uses  OpenSearch with text embeddings to match stored frequently asked questions (FAQs), and knowledge bases on Amazon Bedrock is used to query indexed knowledge base documents. Bot responses are shown in real time to the agent, along with the transcription of the conversation. It is easily configured to support customized intents, FAQs, and knowledgebase content.

Agents and supervisors can also directly interact with the Agent Assist bot using the Agent Assist Bot interactive chat UI. Ask knowledge base questions directly by typing in the question. When End of Call Summarization is enabled, Supervisors or agents can also use the Agent Assist UI to generate a summary of the current live call at any point during the call - useful for supervisors join in to a call in progress, or for agents picking up a transferred call in progress. 

<img src="../images/lca-agentassist-ui-summary.png" alt="Agent Assist UI - Call Summary" width="250"/>
  
  

This body of this README describes how to use and customise this default configuration. 

### Option: Bring your own Lex Bot

Alternatively, you can plug-in your own Amazon LexV2 chat bot to provide Agent Assist logic. Choose `Bring your own LexV2 bot` for `Enable Agent Assist` when deploying or updating the LCA stack. Identify your bot using the parameters `AgentAssistExistingLexV2BotId` and `AgentAssistExistingLexV2BotAliasId`

Your bot provide intents, slots, and integration with backend data and knowledge systems as needed to provide contextually appropriate messages that assist the agent as they guide the conversation with the caller. LCA interacts with your bot using the LexV2 RecognizeText API, passing each caller utterance to the bot, and expecting an Agent Assist message in a response. Use slot elicitation prompts, intent confirmation prompts, intent fulfillment messages and more as agent assist messages. If your bot returns an empty message, or no message, in the response, then no agent assist message is displayed for that turn of the conversation. 

### Option: Bring your own Lambda function

A second alternative allows you to implement your own Agent Assist logic using an AWS Lambda function instead of a Lex bot. Choose `Bring your own AWS Lambda function` when deploying or updating the LCA stack. Identify your Lambda function using the parameter `AgentAssistExistingLambdaFunctionArn`.

LCA interacts uses the Lambda Invoke API to synchronously invoke your function (request mode), passing each caller utterance along with additional call metadata in the event payload. The payload includes `dynamodb_table_name` and `dynamodb_pk`, so your function can query the LCA Call Event table in DynamoDB to retrieve additional call metadata as needed (eg caller number, agentId, etc.).   

Your function returns an Agent Assist message in the Lambda response, in the following JSON format. 
```
{
  "message": "<agent assist message>"
}
```
If your function returns an empty message, or no message, in the response, then no agent assist message is displayed for that turn of the conversation.

You can use the [Fetch Transcript](./FetchTranscriptLambda.md) function to retrieve the cumulative transcript of the call, up to but not including the current transcription segment. This may be useful when your agent assist function requires prior context to process the current segment.


## How it works

Here is the LCA architecture overview showing how Agent Assist fits into the overall real time processing flow.  
  
<img src="../images/lca-chimevc-architecture.png" alt="Agent Assist Architecture" width="800"/>

The default LCA Agent Assist configuration uses the QnABot on AWS solution (v5.5.2 or later). The QnABot provides a single administrative interface, the Content Designer, which is used to create Lex Intents, and FAQs. 
Learn about QnABot on AWS by reviewing the solution [Landing page](https://aws.amazon.com/solutions/implementations/aws-qnabot/) and [Implementation Guide](https://docs.aws.amazon.com/solutions/latest/qnabot-on-aws/welcome.html). 

QnABot uses **Amazon Lex** to manage conversational requests and reponses. 

Amazon Lex is an AWS service for building conversational interfaces - see [Amazon Lex features](https://aws.amazon.com/lex/features/) to to learn about the key concepts, such as Intents, Utterances, Slots, etc. 

Typically, a Lex bot is used in a contact center to automate a conversation with a caller, where the caller and the bot communicate directly. However, in the Agent Assist scenario we use Lex differently. Here, the caller and the agent communicate directly. The bot 'listens in' but does not directly interact with the caller. Instead, based on what the caller says, the bot provides advice to the agent, to help them guide the conversation. You've already seen this in action in the [LCA blog post tutorial](www.amazon.com/live-call-analytics).

By default, QnABot uses Amazon Bedrock to generate text embeddings for stored items and to use these to find releavnt matches to callers' utterances. For more on how text embeddings work, see [Semantic Question Matching](https://docs.aws.amazon.com/solutions/latest/qnabot-on-aws/use-qnabot-on-aws.html#semantic-question-matching).

QnABot also uses **knowledge bases on Amazon Bedrock**  as an integrated knowledge base and ML powered intelligent search service that finds the best response to a caller's enquiry from 'unstructured' documents such as crawled web pages, word documents, or other sources that have been ingested into a knowledge base using a data source connector. See [Knowledge base on Amazon Bedrock features](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html) to to learn about the key concepts, such as Indexes, FAQs, Connectors, etc. 

Also read the QnABot Implementation Guide at [Configure intent and slot matching](https://docs.aws.amazon.com/solutions/latest/qnabot-on-aws/intent-and-slot-matching.html) to learn how QnABot (v5.2.0 and later) creates Lex intents and slots directly from the ContentDesigner UI. LCA agent assist uses this feature to identify caller intents and to guide the agent to ask for additional information (slots) when needed. 

Now, recall the example from the [agent assist demo script](lca-agentassist-setup-stack/agent-assist-demo-script.md) that you used already when you installed LCA and followed the tutorial. If a caller says “I’m calling about my card”, but does not specify the type of card, Amazon Lex can identify what the intent is (which is calling about a card), but it still needs more information (the slot value, which is the type of card). In this case, the Agent Assist suggested response would be “What type of card are you interested in? A rewards card or purchase card?”. The caller then can reply with “rewards card”, which will “fulfill” the intent. This means all the required slots have been collected.

## How to enable Agent Assist

By following the tutorial in the [LCA blog post](www.amazon.com/live-call-analytics) you have already installed and configured Agent Assist with the the default option: `QnABot on AWS with new Kendra Index (Developer Edition)`.

Other Agent Assist options can be specified during stack deployment or update by providing values for the **Agent Assist Options** CloudFormation parameters as shown below.

<img src="../images/lca-agentassist-options.png" alt="Agent Assist CloudFormation Parameters" width="800"/>

The main parameter to enable Agent Assist is the “**Enable Agent Assist**” parameter. Here is a description of the parameter options:

|Value	|Description	|
|---	|---	|
|Disabled	|Selecting this value will disable Agent Assist	|
|QnABot on AWS with existing Bedrock knowledge base	|This deploys a new QnABot on AWS with an existing knowledge base. If you select this value, you are required to provide LCA with an existing knowledge base ID in the **BedrockKnowledgeBaseId** CloudFormation parameter.	|
|QnABot on AWS with new Bedrock knowledge base	|This deploys a new QnABot on AWS with a new knowledge base	|
|QnABot on AWS with Bedrock LLM only (no knowledge base) | This deploys a new QnABot on AWS without a new knowledge base.. in this case the selected LLM will respond based on it's 'world knowledge'	|
|Bring your own LexV2 Bot	|Select this value if you already have a pre-configured LexV2 bot. You must provide LCA with the existing Lex Bot ID and Bot Alias in the **AgentAssistExistingLexV2BotId** and **AgentAssistExistingLexV2BotAliasId,** |
|Bring your own Lambda function	|This will send the customer's speech to a Lambda function. This will allow you to build your own custom Agent Assist integrations, for example, look up responses in a 3rd party knowledge base or API.	|

All the values with “QnABot on AWS” will deploy a new QnABot on AWS into your account, pre-configured with example Agent Assist suggested responses. 

Once you have filled out the Agent Assist CloudFormation parameters, finish deploying or updating the LCA stack.  

## Testing Agent Assist

Follow the tutorial in the [LCA blog post](www.amazon.com/live-call-analytics), using the provided demo script as your guide.

Ask the question **“What life insurance policies do you offer?”.**  If Agent Assist is working, you should see the AGENT_ASSISTANT response in blue, similar to the screenshot below:

<img src="../images/lca-agentassist-screenshot.png" alt="Agent Assist Screenshot" width="800"/>

Vary the question a little. Try **"Do you offer life insurance policies?"** or **"Can you tell me what kinds of life insurance policies you have?"**, and other variations to see if you still get the same result.

Some other example phrases you can ask as the caller are below.  See more on response types in the next section.

|Phrase	|Response Type	|Details	|
|---	|---	|---	|
|I’m calling about my rewards card.	|Dynamic response	|1 slots required: Card Type.  Agent Assist suggested responses will ask for these values if necessary. Note: In the phrase, it already says the card type, "rewards card", so Agent Assist knows not to ask for it again. If the caller says 'I'm calling about my card', then Agent Assist will ask which type of card.	|
|What is the cash back rate for this card?	|Dynamic, context aware response	|1 slot required: Card Type. Note: Agent Assist can share the value of slots between different intents, so it may already have the Card Type from the previous phrase and will not ask for it again.|
|What types of accidents are covered by accidental death insurance?	|Knowledge base fallback response	|There is no preconfigured response for this question, so the utterance is sent to the configured knowledge base on Amazon Bedrock to see if there is any relevant information in the knowledge base.	|
|That’s all I need for now.	|Static response	|Many companies require agents to wrap up a call with very specific messaging. This response is tailored to the caller, including the caller's name. 	|

The Agent Assist testing script can be found here: [agent assist demo script](lca-agentassist-setup-stack/agent-assist-demo-script.md)

## Configuring Agent Assist Responses 

When deploying Agent Assist, you received an email titled “QnABot Signup Verification Code” with a temporary password and a link to the QnABot Content Designer. 

<img src="../images/lca-agentassist-qnabot-email.png" alt="QnABot Signup Email" width="500"/>

Click the link to login to the QnABot Content Designer.  The login is **Admin**, and the temporary password is in the email. Be careful not to copy any trailing spaces as you copy/paste the temporary password. You will set a new permanent password the first time you login.

Agent Assist responses can be categorized into 5 types: 

|Response Type	|Details	|
|---	|---	|
|Static response	|This is a simple response to a phrase that does not require any additional information/slots.	|
|Dynamic - Context aware response	|This is a response that requires more information (slots) before it can provide an appropriate suggested answer.  Agent Assist may ask for the values of the slots before providing the final suggested response. Responses can be dynamic and formatted with [handlebars](https://catalog.us-east-1.prod.workshops.aws/workshops/20c56f9e-9c0a-4174-a661-9f40d9f063ac/en-US/qna/handlebars).	|
|Dynamic - custom business logic response	|This will call an AWS Lambda function, along with the entire context, so that you can write custom business logic in the function, such as look up information in a 3rd party database or API.	|
|Knowledge base on Amazon Bedrock fallback response	| If no response with sufficient confidence is found, then caller's utterance is then directly sent to the Bedrock knowledge base.	|


### **Static FAQ Response**

To begin configuring a new static response inside QnABot Designer, select the **Add** button in the upper right.  A popup will appear similar to the following screenshot:

<img src="../images/lca-agentassist-qnabot-addnewitem.png" alt="Add new item" width="400"/>

* Select **qna** as the document type
* Fill in a unique **Item ID**
* Add one or more **Question/Utterance** values. These are examples of phrases that a caller may say to the agent.
* Add the suggested agent response in the **Answer** text box.  This will appear as the AGENT_ASSISTANT message inside of LCA.
* Select **Create** to save your new Agent Assist response.

Use the Designer TEST tab to try a variety of questions that you want to test to see if you get the expected results. Tune the items by editing and adding / modifying sample questions. 

### **Dynamic Response**

#### ***Context aware response***

Responses that have inputs, also called slots, require you to first configure the SlotType. There is one example slot type in the example, SlotType.CARDTYPE. You may also skip creating your own slot type if you want to use any of the built-in Amazon Lex V2 slot types, such as Amazon.FirstName, Amazon.City, etc.  The full list of built-in slot types can be found here: https://docs.aws.amazon.com/lexv2/latest/dg/howitworks-builtins-slots.html

To create a new slot type, select the same **Add** button in the upper right of QnABot Designer, and choose the **slottype** document type. Expand the Advanced section and it will look like the screenshot below:

<img src="../images/lca-agentassist-qnabot-newslottype.png" alt="New Slot Type" width="400"/>

* Fill in the **Slot type name**.  This should be something like SlotType.XYZ
* Fill in the optional **Description**. 
* Decide if you should select **Restrict Slot Values**. Recommendation: Check on.    If checked, only values explicitly defined in the value or synonyms will be accepted. If not checked, then the suggested values will be used as training data, and the actual value collected by the slot may vary.
* Add one or more **Slot type values**.  Each slot type value must contain a value, and may contain optional synonyms. The optional synonyms are a comma separated list of values. For example, the value for ‘checking’ may have the synonym ‘checking account’. 
* When you are done with your slot, select **Create** to save it.

Once you have completed creating your slot types (or have skipped because you will use the default built-in LexV2 slot types), you then need to create a new qid response that will use those slot types.

* Select the same **New** button and choose **qid** as the document type.
* Fill in a unique **Item ID** for this response.
* Fill in one or more **utterances**, or phrases that a user may say where you want to provide the recommended agent response. These utterances may contain a slot type’s value, for example, ‘I’m calling about my rewards card’, where the word rewards is a SlotType.CARDTYPE.  To add these utterances, replace the word rewards with {cardtype}, for example, ‘I’m calling about my {cardtype} card.’  
*  Fill in the **Answer**.  You can use QnABot’s support for [Handlebars](https://github.com/aws-solutions/aws-qnabot/blob/main/docs/Handlebars_README.md) to build complex, dynamic answers based on the value of the slots. If you need to programmatically provide an answer based on a lookup to a database or 3rd party API, you can use a **Lambda Hook** (https://github.com/aws-solutions/aws-qnabot/tree/main/docs/lambda_hooks)
* Select **Advanced** to expose the advanced section.
* Scroll down to ‘**Create a dedicated bot intent for this item during LEX REBUILD**’, and **check** it. 
    * <img src="../images/lca-agentassist-qnabot-rebuildlexcheck.png" alt="Rebuild Lex Checkbox" width="400"/>
* Scroll down to the Slot section and fill out the following information for each slot used by this qid.
    * <img src="../images/lca-agentassist-qnabot-slotdetails.png" alt="Slot Details" width="500"/>
    * **Slot required checkbox** - This will force the customer to provide the slot value before a suggested answer will be provided to the agent
    * **Cache slot value checkbox** - This will allow Agent Assist responses (qids) to share the value of this slot with other responses
    * **Slot name** - This value is used in the utterance (for example, {cardtype} above), as well as sets as sets a Lex session attribute with the same key/name.
    * **Slot type** - this defines what type of information will be collected. It may be a slot type that you defined, for example, SlotType.CARDTYPE, *or* it may be one of the Built-In slot types such as Amazon.FirstName, Amazon.City, etc.  More about built-in slot types here: https://docs.aws.amazon.com/lexv2/latest/dg/howitworks-builtins-slots.html
    * **Slot prompt** - If the caller does not provide an utterance that has the slot value, this is the Agent Assist suggested response that prompts the agent to ask for this slot.  For example, ‘Ask: Is this a rewards card, or a purchase card?“
    * **Slot sample utterances** - This is a comma delimited list of utterances a user may reply after being asked about the slot, for example, ‘It's a {cardtype} card'.  
        **Note**: you must use the Slot name with handlebars in the utterance.
        **Second Note**: Slot sample utterances are not required for the built-in LexV2 responses.
* When complete with entering in all slots, scroll to the very bottom and select **Create** to save your new slot-based Agent Assist suggested response. 

You cannot use the Designer TEST tab to test these context aware items, since they are implemented as Lex bot intents rather than QnABot queries. After you Rebuild the Lex Bot as described below, you can test using the QnABot web client, or by making test phone calls using the LCA demo asterisk server.

#### ***Dynamic Custom Business Logic***

Custom business logic is accomplished by writing a custom AWS Lambda Function. This provides the capability for looking up information from almost any 3rd party data source, or building other custom integrations. For an example of calling an AWS Lambda function from an Agent Assist response, see the [QnABot on AWS Lambda Hooks README](https://github.com/aws-solutions/aws-qnabot/tree/main/docs/lambda_hooks). 

### **Amazon Bedrock Knowledge Base Fallback Response**

This is the simplest method to use for Agent Assist, as there is no setup required, other than to ingest documents into your knowledge base!

If there are no matching Agent Assist responses found based on the items you configured usiong Content Designer (above), the user’s utterance will be sent to the knowledge base on Amazon Bedrock, which searches its index of unstructured documents such as crawled web pages, word or PDF documents, or documents ingested from any data source connector.  

Questions are answered using the context of the meeting transcript, so it can handle followup questions in the correct context.


### **Rebuild Lex Bot**

Once all the Agent Assist responses have been defined, you must rebuild the Lex bot.  Choose the menu in the upper right corner (⋮), and choose **Rebuild Lex**.

<img src="../images/lca-agentassist-qnabot-lexrebuild.png" alt="Rebuild Lex" width="200"/>


