ARG NODE_VERSION=20

# First, build the project - explicitly specify platform for ECS Fargate compatibility
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:20-bookworm AS builder

# Install Python 3.11 and update vulnerable packages
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y python3 python3-dev python3-pip && \
    # Update specific vulnerable packages to latest security-patched versions
    apt-get install -y --only-upgrade ncurses-base ncurses-bin libncurses6 libncursesw6 || true && \
    apt-get install -y --only-upgrade gnutls-bin libgnutls30 libgnutls28-dev || true && \
    apt-get install -y --only-upgrade libc6 libc-bin libc6-dev || true && \
    apt-get install -y --only-upgrade util-linux || true && \
    apt-get install -y --only-upgrade tar || true && \
    ln -sfn /usr/bin/python3 /usr/bin/python && \
    ln -sfn /usr/bin/pip3 /usr/bin/pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY [\
    "./.eslintrc",\
    "./.eslintignore",\
    "./package.json",\
    "./tsconfig.json",\
    "/app/"\
]

# Install dependencies and regenerate lock file
RUN npm install

COPY "./src" "/app/src"

RUN npm run build

RUN npm prune --production

# Now create the runtime image and copy the build artifacts into it - explicitly specify platform for ECS Fargate compatibility
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:20-slim AS runtime

# Update vulnerable packages in runtime image
RUN apt-get update && \
    apt-get upgrade -y && \
    # Update specific vulnerable packages to latest security-patched versions
    apt-get install -y --only-upgrade ncurses-base ncurses-bin libncurses6 libncursesw6 || true && \
    apt-get install -y --only-upgrade gnutls-bin libgnutls30 libgnutls28-dev || true && \
    apt-get install -y --only-upgrade libc6 libc-bin libc6-dev || true && \
    apt-get install -y --only-upgrade util-linux || true && \
    apt-get install -y --only-upgrade tar || true && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

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
