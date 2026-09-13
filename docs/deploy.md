# Deploying Ionnet GSM

## Docker Compose (recommended)

```sh
git clone git@github.com:ionnet-dev/gsm.git ionnet-gsm && cd ionnet-gsm
cat > .env <<'ENV'
SITE_URL=https://gsm.example.com
SESSION_SECRET=$(openssl rand -hex 32)
DB_PASSWORD=$(openssl rand -hex 16)
DB_ROOT_PASSWORD=$(openssl rand -hex 16)
ENV
docker compose up -d --build
```

The image builds the web app and compiles agent binaries for x86_64 and aarch64 under the
Dockerfile's `VERSION` build arg. They live outside the data volume, in `/app/agent-dist`; on start
the server copies a version it hasn't seen into `DATA_DIR`, registers it and, when it is newer than
the current latest, marks it latest, so `/install.sh` uses it. Built-in templates are seeded from
`/app/templates`. Migrations run automatically (`AUTO_MIGRATE=true`).

Open `SITE_URL`, create the first administrator, then Settings → Enrollment → New token to enroll
your first node.

## Nodes

A node is any Linux machine (x86_64 or aarch64, systemd) with Docker installed. The agent runs as
root under systemd, talks to the Docker socket, and keeps instance data under `/var/lib/gsm`:

```
/var/lib/gsm/instances/<uuid>   the instance's files, mounted at /data in its container
/var/lib/gsm/logs/<uuid>        console.log and install.log
/var/lib/gsm/backups/<uuid>     <backupId>.tar.gz
/var/lib/gsm/state/<uuid>.json  the last spec the agent saw, for graceful stops after a restart
```

Enroll with the one-liner from Settings → Enrollment:

```sh
curl -fsSL https://gsm.example.com/install.sh | sudo sh -s -- \
  --server https://gsm.example.com --token gsm_enr_...
```

Open the node's port range (default 30000–30999, TCP and UDP) in its firewall. Instances are
published on the node's bind address (default every interface); players connect to the node's public
address, which defaults to the address the agent connects from and can be set per node.

The instance images come from `ghcr.io/ionnet-dev` (Settings → General → Image registry). Nodes pull
them on first use; for a private registry, enter credentials under Settings → General → Registry,
which every agent receives.

## Reverse proxy

GSM expects TLS termination in front of it and needs WebSockets passed through. Caddy:

```
gsm.example.com {
    reverse_proxy gsm-server:3000 {
        lb_try_duration 30s
        lb_try_interval 250ms
    }
}
```

nginx:

```
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
    client_max_body_size 100m;  # agent release uploads
}

# File transfers stream through the server at any size: don't cap or buffer them.
location ~ ^/api/v1/(agents/transfers/|files/|instances/[0-9]+/(files|backups)/) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

`SITE_URL` must match the public origin exactly: it is used for the WebSocket `Origin` check, cookie
security and links in emails. See `security.md` for `TRUST_PROXY`.

## Environment

| Variable                          | Default                                | Purpose                                                                   |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `SITE_URL`                        | `http://localhost:5173`                | Public origin                                                             |
| `SESSION_SECRET`                  | —                                      | ≥ 32 random characters; keys session ids and encrypts authenticator seeds |
| `TRUST_PROXY`                     | `true`                                 | Use the last `X-Forwarded-For` hop as the client IP                       |
| `DB_HOST/PORT/NAME/USER/PASSWORD` | `127.0.0.1/3306/gsm/gsm/gsm`           | MySQL 8 connection                                                        |
| `AUTO_MIGRATE`                    | `true`                                 | Run pending migrations at startup                                         |
| `DATA_DIR`                        | `./data`                               | Agent releases (persist this volume)                                      |
| `TEMPLATES_DIR`                   | `../templates`                         | Built-in template JSON files                                              |
| `BUNDLED_AGENTS_DIR`              | unset (`/app/agent-dist` in the image) | Agent builds baked into the image                                         |
| `WEB_DIST`                        | `../web/dist`                          | Built web app served by the server                                        |
| `LOG_LEVEL`                       | `info`                                 | `debug`, `info`, `warn`, `error` (JSON logs in production)                |

## Operations

- **Backups of GSM itself**: the MySQL volume (`gsm-mysql`) plus `DATA_DIR` (`gsm-data`). Instance
  data and instance backups live on the nodes under `/var/lib/gsm`; back those up there.
- **Upgrades**: `docker compose pull && docker compose up -d` (or rebuild). Migrations are
  forward-only and applied on start. When the agent changed, bump `VERSION` in the Dockerfile and
  roll it out under Settings → Agent releases; agents restart into the new binary while their
  containers keep running.
- **Locked-out users**: `docker compose exec server deno task 2fa:reset <email>`.
- **Single node**: the server keeps agent connections, console buffers and loops in memory; run one
  replica. A redeploy restarts the one server; agents and browsers reconnect within seconds and
  instances are untouched (they are containers on the nodes).
- **Health**: `GET /api/v1/health` returns `{ status, version, db, pendingMigrations }`.
