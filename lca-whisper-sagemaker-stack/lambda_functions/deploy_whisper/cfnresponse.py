import json
import logging
import urllib.request
import time

SUCCESS = "SUCCESS"
FAILED = "FAILED"

def send(event, context, responseStatus, responseData, physicalResourceId=None, noEcho=False, reason=None, max_retries=3, retry_delay=2):
    """
    Send a response to CloudFormation regarding the success or failure of a custom resource deployment.
    
    Args:
        event: The Lambda event
        context: The Lambda context
        responseStatus: SUCCESS or FAILED
        responseData: Data to send back to CloudFormation (dictionary)
        physicalResourceId: The physical resource ID to use (defaults to Lambda log stream name)
        noEcho: Whether to mask the response in CloudFormation logs
        reason: Reason for success/failure
        max_retries: Maximum number of retries if sending fails
        retry_delay: Delay between retries in seconds
        
    Returns:
        True if the response was sent successfully, False otherwise
    """
    # For Delete requests, always return SUCCESS to prevent stack from getting stuck
    if event.get('RequestType') == 'Delete' and responseStatus == FAILED:
        logging.warning("Converting FAILED status to SUCCESS for Delete request to prevent stack from getting stuck")
        responseStatus = SUCCESS
        if not reason:
            reason = "Reporting success despite errors to prevent stack from getting stuck in DELETE_IN_PROGRESS state"
    
    responseUrl = event['ResponseURL']
    logging.info(f"Sending response to {responseUrl}")

    responseBody = {
        'Status': responseStatus,
        'Reason': reason or f"See the details in CloudWatch Log Stream: {context.log_stream_name}",
        'PhysicalResourceId': physicalResourceId or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'NoEcho': noEcho,
        'Data': responseData
    }

    json_responseBody = json.dumps(responseBody)
    logging.info(f"Response body: {json_responseBody}")

    headers = {
        'content-type': '',
        'content-length': str(len(json_responseBody))
    }

    # Implement retry logic
    retries = 0
    while retries <= max_retries:
        try:
            req = urllib.request.Request(
                responseUrl,
                data=json_responseBody.encode('utf-8'),
                headers=headers,
                method='PUT'
            )
            with urllib.request.urlopen(req) as response:
                logging.info(f"Status code: {response.getcode()}")
                logging.info(f"Status message: {response.msg}")
            return True
        except Exception as e:
            retries += 1
            if retries > max_retries:
                logging.error(f"Failed to send response after {max_retries} retries: {str(e)}")
                return False
            else:
                logging.warning(f"Failed to send response, retrying in {retry_delay} seconds (attempt {retries}/{max_retries}): {str(e)}")
                time.sleep(retry_delay)
                # Exponential backoff
                retry_delay *= 2
