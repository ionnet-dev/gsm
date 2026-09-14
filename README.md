# Ionnet GSM

Game server manager. A central panel with a web UI, plus a small agent on every node that runs game
servers as Docker containers. GSM installs servers from templates (Minecraft: Java Edition vanilla,
Forge and NeoForge, 7 Days to Die and Garry's Mod built in; custom templates for anything else,
including prebuilt images with their own volumes and a MariaDB database beside them), streams their
consoles, manages their files and backups, and lets you share each server with other users at the
role you choose.

```
Browser ──HTTPS/WSS──▶ reverse proxy ──▶ gsm-server (Deno · Hono · Sequelize · MySQL)
                                             ▲ WSS /ws/agent (outbound from each node)
                              gsm-agent (Go, systemd) on every node ──▶ Docker
```

## Repository

| Path         | What                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `server/`    | API + WebSocket gateways. Deno 2, Hono, Sequelize 6, umzug, MySQL            |
| `web/`       | React 19 + Vite, Tailwind 4, shadcn/ui, TanStack Router/Query                |
| `shared/`    | Protocol and API types shared by server and web (zod schemas)                |
| `agent/`     | Go agent: Docker, consoles, files, backups                                   |
| `images/`    | Dockerfiles for the instance images (`gsm-base`, `gsm-java`, `gsm-steamcmd`) |
| `templates/` | Built-in game templates                                                      |
| `docs/`      | Architecture, API, wire protocol, deployment, security                       |
| `scripts/`   | `install-agent.sh` one-line enrollment script                                |

## Development

Requirements: Deno 2.9+, Go 1.24+, Docker (for MySQL and, on a node, for instances).

```sh
cp .env.example .env            # adjust SESSION_SECRET
deno task db:up                 # MySQL 8 on :3306 (docker compose)
deno task dev                   # server :3000 + web :5173 with hot reload
```

Other tasks:

```sh
deno task migrate up|down|pending|executed|create <name>
deno task test
deno task build                 # builds web/dist, served by the server in production
deno task images:build          # gsm-base, gsm-java:{8,17,21,25} and gsm-steamcmd locally
cd agent && go build -o bin/gsm-agent ./cmd/gsm-agent
```

Run an agent on this machine against the dev server (it needs the Docker socket and a writable data
directory):

```sh
sudo ./agent/bin/gsm-agent enroll -server http://localhost:3000 -token <enrollment token from Settings>
sudo ./agent/bin/gsm-agent run
```

## Deploying

See `docs/deploy.md` (and `docs/security.md` for the threat model and proxy notes):
`docker compose up -d --build` with `SITE_URL`, `SESSION_SECRET` and database passwords in `.env`,
behind a TLS-terminating reverse proxy that passes WebSockets through.

## Conventions

- Server modules live in `server/src/modules/<domain>/` and contain `routes.ts` (thin Hono routes),
  `service.ts` (logic, audit, events), `models.ts` (Sequelize) and `schemas.ts` (zod request
  validation). Cross-cutting code goes in `server/src/lib/`.
- REST under `/api/v1` (`docs/api.md`), WebSockets under `/ws`. Errors are always
  `{ error: { code, message, details? } }`.
- Database: snake_case, plural tables, `created_at` / `updated_at` everywhere.
- Web: TanStack file routes in `web/src/routes/`, one Query hook file per API module in
  `web/src/api/`, shadcn primitives in `web/src/components/ui/`.
- Anything the agent and server both speak lives in `shared/src/protocol/` with a hand-mirrored Go
  struct in `agent/internal/protocol/`. `docs/protocol.md` is the contract.
