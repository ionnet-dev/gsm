# Ionnet GSM — working notes for coding agents

Game server manager. Monorepo: `shared/` (zod protocol + DTO types), `server/` (Deno 2 · Hono ·
Sequelize · MySQL), `web/` (React 19 · Vite · Tailwind 4 · shadcn-style components · TanStack
Router/Query), `agent/` (Go; drives Docker on each node), `images/` (Dockerfiles for the instance
images), `templates/` (built-in game templates). See `docs/architecture.md`, `docs/api.md` and
`docs/protocol.md` before changing the wire protocol or REST shapes, and `docs/security.md` before
touching auth, sessions or rate limiting.

## Commands

```sh
deno task db:up            # MySQL 8 via docker compose
deno task dev:server       # server :3000
deno task dev:web          # Vite :5173
deno task migrate up       # migrations are explicit files in server/migrations + index.ts
deno task test             # Deno tests (shared, server) + go test
cd web && deno run -A npm:vite build
cd agent && go build -o bin/gsm-agent ./cmd/gsm-agent
deno task agent:build      # stage agent binaries into server/data/downloads so /install.sh works in dev
deno task images:build     # build gsm-base, gsm-java:{8,17,21,25} and gsm-steamcmd locally
deno task 2fa:reset <email>  # turn off 2FA for a locked-out user
```

Typecheck: `deno check src/mod.ts` (shared), `deno check src/main.ts` (server),
`deno check src/main.tsx` (web). Format with `deno fmt` and `gofmt` before finishing.

## Conventions

- Server modules live in `server/src/modules/<domain>/` with `routes.ts` (thin), `service.ts`
  (logic, audit, UI events), `models.ts` (Sequelize, every attribute `declare`d), `schemas.ts`
  (zod). Associations are wired only in `server/src/db/models.ts`.
- Every server → agent method and agent → server event is a zod schema in `shared/src/protocol/*`
  mirrored by hand in `agent/internal/protocol/types.go`; add both and update `docs/protocol.md`.
- REST shapes (DTOs, request bodies) live in `shared/src/api/*` and are documented in `docs/api.md`.
- Instance routes check per-instance permissions with `assertInstancePermission` from
  `modules/instances/access.ts`; never trust the site role alone for instance actions.
- Web data access goes through hooks in `web/src/api/*`; live updates arrive via
  `web/src/ws/ui-socket.ts` and invalidate query keys — do not add ad-hoc polling.
- Audit every state change with `auditFrom(c, "domain.action", …)`.
- When code in the agent is modified, bump `VERSION` in the Dockerfile (major.minor.patch by the
  size of the change).
- Names: the product is "Ionnet GSM" (GSM = game server manager). Do not reference other products.

## Gotchas

- Deno + Sequelize: pass `dialectModule: mysql2`; migrations are an explicit list (no glob).
- zod v4: `.default()` on object schemas needs the full output value.
- The dev agent needs access to the Docker socket; run it with `sudo` or as a user in the `docker`
  group, and point `data_dir` at a directory it can chown to uid 1500.
