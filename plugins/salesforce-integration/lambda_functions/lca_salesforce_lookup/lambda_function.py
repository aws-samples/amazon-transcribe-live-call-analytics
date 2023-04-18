import json, logging, os
import boto3
import datetime
import uuid
import requests

from datetime import datetime, timedelta

from botocore.exceptions import ClientError

DYNAMODB_EXPIRATION_IN_DAYS = 90 
KINESIS_CLIENT = boto3.client('kinesis')

call_data_stream: str

logger = logging.getLogger()

def write_agent_assist_to_kds(
    message
):
    callId = message.get("CallId", None)  
    
    message['EventType'] = "ADD_AGENT_ASSIST"

    if callId:
        try: 
            KINESIS_CLIENT.put_record(
                StreamName=call_data_stream,
                PartitionKey=callId,
                Data=json.dumps(message)
            )
            print("Write AGENT_ASSIST event to KDS: %s", json.dumps(message))
        except Exception as error:
            logger.error(
                error
            )
    return


def lambda_handler(event, context):
    print (event)
    customer_phone_number = event["CustomerPhoneNumber"]
    call_id = event['CallId']
    
    global call_data_stream
    
    call_data_stream = event['CallDataStream']
    
    phone = "'%%%s%%%s%%%s%%'" % (customer_phone_number[-10:-7], customer_phone_number[-7:-4], customer_phone_number[-4:])

    query = "SELECT Id, CreatedDate, Description from Case WHERE ContactPhone LIKE " + phone +  " ORDER BY CreatedDate DESC"
    
    a = get_current_status(query)

    channel: str = "AGENT_ASSISTANT"
    status: str = "TRANSCRIBING"
    is_partial: bool = False
    segment_id = str(uuid.uuid4())
    
    created_at: str = datetime.utcnow().astimezone().isoformat()
    start_time: float = 0.01
    end_time: float = 0.02
    
    message = {
        "CallId":call_id,
        "Channel": channel,
        "CreatedAt": created_at,
        "ExpiresAfter": get_ttl(),
        "EndTime": end_time,
        "IsPartial": is_partial,
        "SegmentId": segment_id,
        "StartTime": start_time,
        "Status": status,
        "Transcript": a,
    }

    print ("WRITING TO KDS")
    write_agent_assist_to_kds(message)
    return

def get_ttl():
    return int((datetime.utcnow() + timedelta(days=int(DYNAMODB_EXPIRATION_IN_DAYS))).timestamp())


def get_arg(kwargs, name):
  if name not in kwargs:
    msg = "'%s' enviroment variable is missing"
    logger.error(msg)
    raise Exception(msg)
  return kwargs[name]
  
def get_current_status(query):
    session = boto3.session.Session()
    secrets = {}
    secrets_manager_client = session.client(
        service_name="secretsmanager"
    )
    sf_credentials_secrets_manager_arn = get_arg(os.environ, "SF_CREDENTIALS_SECRETS_MANAGER_ARN")


    logger.info("Loading credentials")
    secrets = json.loads(secrets_manager_client.get_secret_value(SecretId=sf_credentials_secrets_manager_arn)["SecretString"])

    password = secrets["Password"] + secrets["AccessToken"]
    consumer_key = secrets["ConsumerKey"]
    consumer_secret = secrets["ConsumerSecret"]
    auth_token = secrets["AuthToken"] if "AuthToken" in secrets else ''
    headers = { 
        'Authorization': 'Bearer %s' % auth_token,
        'Content-Type': 'application/json'
    }
    logger.info("Credentials Loaded")
    
    version=get_arg(os.environ, "SF_VERSION")
    host=get_arg(os.environ, "SF_HOST")
    username=get_arg(os.environ, "SF_USERNAME")

    login_host = host
    request = Request()
    auth_data = {
        'grant_type': 'password',
        'client_id': consumer_key,
        'client_secret': consumer_secret,
        'username': username,
        'password': password
    }

    if get_arg(os.environ, "SF_PRODUCTION").lower() == "true":
        set_production()

    logger.info("Salesforce: Query")

    url = '%s/services/data/%s/query' % (host, version)
    resp = makeRequest(request.get, headers, login_host, secrets, secrets_manager_client, sf_credentials_secrets_manager_arn, auth_data, **{"url": url, "params":{'q':query}})
    data = resp.json()
    print(data)
    a = "<b>Summary from the most recent interactions</b><table border:1px solid black>"
    conv = lambda i : i or ''
    j = 0
    for record in data['records']:
      a = a + "<tr border:1px solid black><td border:1px solid black>" + conv(record['CreatedDate'][0:10]) + " " + conv(record['CreatedDate'][11:19]) + "</td><td border:1px solid black>" + conv(record['Description']) + "</td></tr>"
      j = j + 1
      if (j == 3):
        break
    
    a = a + "</table>"  
    print (a)
    return a

def makeRequest(requestMethod, headers, login_host, secrets, secrets_manager_client, sf_credentials_secrets_manager_arn, auth_data, **kwargs):
    try:
      return requestMethod(**kwargs, headers=headers)
    except Exception as e:
      # try re-fetching auth token
      logger.info("Retrieving new Salesforce OAuth token")
      headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
      request = Request()

      resp = request.post(url=login_host+"/services/oauth2/token", params=auth_data, headers=headers, hideData=True)
      data = resp.json()
      auth_token = secrets["AuthToken"] = data['access_token']
      headers = kwargs['headers'] = { 
        'Authorization': 'Bearer %s' % auth_token,
        'Content-Type': 'application/json'
      }
      try:
        secrets_manager_client.put_secret_value(SecretId=sf_credentials_secrets_manager_arn, SecretString=json.dumps(secrets))
      except ClientError as e:
        # LimitExceededException occurs when there are too many versions of a secret in SecretsManager.
        # Secret versions are cleaned up in the background but sometimes this doesn't happen fast enough.
        # In this case, the error is safe to ignore.
        if e.response['Error']['Code'] == 'LimitExceededException':
          logger.error(str(e))
        else:
          raise e
      return requestMethod(**kwargs)

class Request:
  def post(self, url, headers, data=None, params=None, hideData=False):
    logger.info('POST Requests:\nurl=%s' % url)
    if not hideData:
      logger.info("data=%s\nparams=%s" % (data, params))
    r = requests.post(url=url, data=json.dumps(data), params=params, headers=headers)
    if not hideData:
      logger.info("Response: %s" % r.text)
    return __check_resp__(r)

  def delete(self, url, headers):
    logger.info("DELETE Requests:\nurl=%s" % url)
    r = requests.delete(url=url, headers=headers)
    logger.info("Response: %s" % r.text)
    return __check_resp__(r)

  def patch(self, url, data, headers):
    logger.info("PATCH Requests:\nurl=%s\ndata=%s" % (url, data))
    r = requests.patch(url=url, data=json.dumps(data), headers=headers)
    logger.info("Response: %s" % r.text)
    return __check_resp__(r)

  def get(self, url, params, headers):
    logger.info("GET Requests:\nurl=%s\nparams=%s" % (url, params))
    r = requests.get(url=url, params=params, headers=headers)
    logger.info("Response: %s" % r.text)
    return __check_resp__(r)

def __check_resp__(resp):
  if resp.status_code // 100 == 2: 
    return resp
  
  if resp.status_code == 401:
    raise Exception("")
  
  data = resp.json()
  if 'error' in data:
    msg = "%s: %s" % (data['error'], data['error_description'])
    logger.error(msg)
    raise Exception(msg)
  
  if isinstance(data, list):
    for error in data:
      if 'message' in error:
        msg = "%s: %s" % (error['errorCode'], error['message'])
        logger.error(msg)
        raise Exception(msg)

  msg = "request returned status code: %d" % resp.status_code
  logger.error(msg)
  raise Exception(msg)

