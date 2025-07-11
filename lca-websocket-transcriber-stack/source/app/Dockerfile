ARG NODE_VERSION=16

# First, build the project
FROM public.ecr.aws/docker/library/node:16-bullseye AS builder

# Install Python 3.9 (available in Bullseye) for build process
RUN apt-get update && \
    apt-get install -y python3 python3-dev python3-pip && \
    ln -sfn /usr/bin/python3 /usr/bin/python && \
    ln -sfn /usr/bin/pip3 /usr/bin/pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY [\
    "./.eslintrc",\
    "./.eslintignore",\
    "./package.json",\
    "./package-lock.json",\
    "./tsconfig.json",\
    "/app/"\
]

RUN npm ci

COPY "./src" "/app/src"

RUN npm run build

RUN npm prune --production

# Now create the runtime image and copy the build artifacts into it
FROM public.ecr.aws/docker/library/node:16-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV LOG_ROOT_DIR=/tmp/
ENV SERVERPORT=8080
ENV SERVERHOST=0.0.0.0
EXPOSE $SERVERPORT

COPY --from=builder "/app/node_modules/" "/app/node_modules"
COPY --from=builder "/app/dist" "/app/dist"

USER node
ENTRYPOINT ["node", "/app/dist/index.js"]
