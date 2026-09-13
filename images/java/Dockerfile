# syntax=docker/dockerfile:1
# gsm-java:<version>: the base image plus an Eclipse Temurin JRE, for Minecraft: Java Edition and
# other JVM servers. Build with --build-arg JAVA_VERSION=8|11|17|21.
ARG BASE=ghcr.io/ionnet-dev/gsm-base:latest
FROM ${BASE}

ARG JAVA_VERSION=21

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg \
 && mkdir -p /etc/apt/keyrings \
 && wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public \
      | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" \
      > /etc/apt/sources.list.d/adoptium.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends temurin-${JAVA_VERSION}-jre \
 && apt-get purge -y --auto-remove wget gnupg \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_VERSION=${JAVA_VERSION}

LABEL org.opencontainers.image.source="https://github.com/ionnet-dev/gsm" \
      org.opencontainers.image.description="Ionnet GSM instance image with Temurin JRE ${JAVA_VERSION}"
