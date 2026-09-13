# syntax=docker/dockerfile:1
# Multi-stage build: compile the Go agent for download hosting, build the web app, run the server on Deno.

FROM golang:1.27-alpine AS agent
WORKDIR /src
COPY agent/ .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/x86_64 ./cmd/gsm-agent \
 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/aarch64 ./cmd/gsm-agent \
 && cd /out && for f in x86_64 aarch64; do sha256sum $f | cut -d' ' -f1 > $f.sha256; done

FROM denoland/deno:2.9.5 AS web
WORKDIR /app
COPY deno.json deno.lock ./
COPY shared/ shared/
COPY server/deno.json server/
COPY web/ web/
RUN deno install --allow-scripts && cd web && deno run -A npm:vite build

FROM denoland/deno:2.9.5
WORKDIR /app
ARG VERSION=0.1.0
COPY deno.json deno.lock ./
COPY shared/ shared/
COPY server/ server/
COPY web/deno.json web/package.json web/
COPY scripts/ scripts/
COPY templates/ templates/
COPY agent/packaging/ agent/packaging/
COPY --from=web /app/web/dist web/dist
# Not under /app/data: that is a volume, and a volume hides whatever a newer image ships there.
# The server copies these into DATA_DIR and registers them as a release on start.
COPY --from=agent /out/ /app/agent-dist/${VERSION}/
RUN deno install --allow-scripts \
 && cd server && deno cache src/main.ts
ENV DENO_ENV=production PORT=3000 WEB_DIST=../web/dist DATA_DIR=/app/data LOG_LEVEL=info \
    TEMPLATES_DIR=../templates BUNDLED_AGENTS_DIR=/app/agent-dist
EXPOSE 3000
VOLUME ["/app/data"]
WORKDIR /app/server
CMD ["deno", "run", "-A", "src/main.ts"]
