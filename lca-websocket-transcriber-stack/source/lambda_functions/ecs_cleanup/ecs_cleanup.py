import json
import boto3
import cfnresponse

def lambda_handler(event, context):
    ecs = boto3.client('ecs')
    response_data = {}

    try:
        if event['RequestType'] == 'Delete':
            cluster_name = event['ResourceProperties']['ClusterName']
            
            # List services in the cluster
            services = ecs.list_services(cluster=cluster_name)['serviceArns']
            if services:
                # Update services to desired count 0
                for service in services:
                    ecs.update_service(cluster=cluster_name, service=service, desiredCount=0)
                
                # Wait for running tasks to stop
                waiter = ecs.get_waiter('services_stable')
                waiter.wait(cluster=cluster_name, services=services)
                
                # Delete services
                for service in services:
                    ecs.delete_service(cluster=cluster_name, service=service)

            response_data['Message'] = "ECS services stopped and deleted successfully"

        cfnresponse.send(event, context, cfnresponse.SUCCESS, response_data)

    except Exception as e:
        response_data['Message'] = str(e)
        cfnresponse.send(event, context, cfnresponse.FAILED, response_data)

