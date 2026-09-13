# syntax=docker/dockerfile:1
# gsm-steamcmd: the base image plus Valve's SteamCMD and the libraries Steam dedicated servers
# need (7 Days to Die, ...). Templates use it both to install (steamcmd +app_update) and to run.
ARG BASE=ghcr.io/ionnet-dev/gsm-base:latest
FROM ${BASE}

# SteamCMD is 32-bit; the game servers themselves are 64-bit Unity/Source builds.
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends lib32gcc-s1 lib32stdc++6 libstdc++6 libgcc-s1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/steamcmd \
 && curl -fsSL --retry 3 https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
      | tar -xz -C /opt/steamcmd \
 && chown -R gsm:gsm /opt/steamcmd

# SteamCMD updates itself on first run; do it now as the instance user so installs start fast
# and /opt/steamcmd stays writable for later self-updates.
USER gsm
RUN HOME=/tmp/steam-home /opt/steamcmd/steamcmd.sh +quit || true; rm -rf /tmp/steam-home
USER root
RUN printf '#!/bin/sh\nexec /opt/steamcmd/steamcmd.sh "$@"\n' > /usr/local/bin/steamcmd \
 && chmod 0755 /usr/local/bin/steamcmd

LABEL org.opencontainers.image.source="https://github.com/ionnet-dev/gsm" \
      org.opencontainers.image.description="Ionnet GSM instance image with SteamCMD"
