FROM public.ecr.aws/lambda/nodejs:18

# Install system dependencies for node-vad
RUN yum update -y && \
    yum install -y gcc-c++ make python3 git

# Copy package.json and install dependencies
COPY package*.json ${LAMBDA_TASK_ROOT}/
RUN npm install

# Copy function code
COPY . ${LAMBDA_TASK_ROOT}

# Set the CMD to your handler
CMD [ "index.handler" ] 