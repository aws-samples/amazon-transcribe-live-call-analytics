const { KinesisClient } = require('@aws-sdk/client-kinesis');

const {
  writeUpdateAgentToKds,
} = require('./lca');

const REGION = process.env.REGION || 'us-east-1';
const CONNECT_INSTANCE_ARN = process.env.CONNECT_INSTANCE_ARN || '';
let kinesisClient;

const handler = async function handler(event, context) {
  console.log('Event: ', JSON.stringify(event));
  kinesisClient = new KinesisClient({ region: REGION });
  if (event.Details.ContactData.InstanceARN !== CONNECT_INSTANCE_ARN) {
    console.log('Wrong Amazon Connect instance.');
    return {
      'statusCode': 500,
      'body': 'Wrong Amazon Connect Instance'
    };
  }

  const callId = event.Details.ContactData.ContactId;
  let agentId = (event.Details.ContactData.Attributes?.AgentId ?? '');
  if (agentId != '') {
    await writeUpdateAgentToKds(kinesisClient, callId, agentId);
    return {
      'statusCode': 200,
      'body': 'Agent Id updated.'
    }
  }   
  return {
    'statusCode': 500,
    'body': 'Invalid agentId.'
  }
};

exports.handler = handler;