# syntax=docker/dockerfile:1
# gsm-base: the shared base for every instance image. Debian, a fixed unprivileged user (uid/gid
# 1500, the owner of every instance's data directory), tini as PID 1, and an entrypoint that fills
# {{VAR}} placeholders in the startup command from the environment.
FROM debian:bookworm-slim

ARG GSM_UID=1500
ARG GSM_GID=1500

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl jq unzip zip tar gzip xz-utils tini procps locales tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && groupadd -g ${GSM_GID} gsm \
 && useradd -u ${GSM_UID} -g ${GSM_GID} -d /data -M -s /bin/sh gsm \
 && mkdir -p /data /gsm && chown gsm:gsm /data

COPY entrypoint.sh /gsm/entrypoint.sh
RUN chmod 0755 /gsm/entrypoint.sh

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/data \
    GSM_BIND=0.0.0.0

WORKDIR /data
# The agent sets --user 1500:1500 for instances and installs alike.
ENTRYPOINT ["/usr/bin/tini", "--", "/gsm/entrypoint.sh"]
CMD ["sh", "-c", "echo '[GSM] no startup command'; exit 1"]

LABEL org.opencontainers.image.source="https://github.com/ionnet-dev/gsm" \
      org.opencontainers.image.description="Ionnet GSM base image for game server instances"
