# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# Install dependencies and build jar

FROM public.ecr.aws/bitnami/gradle:7.2.0 as build

RUN pwd
RUN ls -altr

WORKDIR /build
COPY src /build/src
COPY build.gradle .
RUN gradle buildFargate --info --warning-mode all --no-daemon

RUN find /build -name '*.jar' -ls

# use same version as installed in local environment
FROM public.ecr.aws/amazoncorretto/amazoncorretto:11.0.12-al2

WORKDIR /app

COPY --from=build /build/build/libs/build.jar /app/kvsrecord.jar

ENTRYPOINT ["java", "-jar", "/app/kvsrecord.jar"]
