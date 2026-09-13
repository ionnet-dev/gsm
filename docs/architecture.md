# Architecture

```
Browser ──HTTPS/WSS──▶ reverse proxy (TLS) ──▶ gsm-server ──▶ MySQL 8
                                                  ▲ WSS /ws/agent (outbound from each node)
                                  gsm-agent (Go, root, systemd) on every node
                                        └─▶ Docker: one container per game server instance
```

## Components

| Component    | Runtime           | Responsibilities                                                                    |
| ------------ | ----------------- | ----------------------------------------------------------------------------------- |
| `server/`    | Deno 2, Hono      | REST API under `/api/v1`, agent + browser WebSocket gateways, background loops      |
| `web/`       | React 19, Vite    | Single-page app; talks REST for reads/writes and listens on `/ws/ui` for pushes     |
| `agent/`     | Go, static binary | Drives Docker on a node: installs, starts, stops, attaches consoles, files, backups |
| `shared/`    | TypeScript + zod  | Wire protocol and DTO types used by server and web; mirrored by hand in Go          |
| `images/`    | Dockerfiles       | `gsm-base` (Debian, `gsm` user 1500, entrypoint) and `gsm-java:<version>`           |
| `templates/` | JSON              | Built-in game templates, seeded into the database on start                          |

## Server layout

Every domain lives in `server/src/modules/<domain>/` with the same files:

- `routes.ts` — thin Hono routes: parse, authorise, call service, respond
- `service.ts` — business logic; writes audit entries; emits UI events
- `models.ts` — Sequelize models (every attribute is `declare`d)
- `schemas.ts` — zod request schemas (most shapes come from `@gsm/shared`)

Cross-cutting code is in `server/src/lib/` (errors, logger, ids, rate limiting, secret box, mailer,
an in-process event bus). `server/src/ws/` holds the two gateways. `server/src/jobs/` holds loops
(offline detection, housekeeping). `server/src/db/models.ts` registers every model and wires all
associations in one place so module files never import each other at runtime.

Migrations are explicit files in `server/migrations/` listed in `index.ts` (umzug needs an explicit
list under Deno). They run automatically at startup when `AUTO_MIGRATE=true`.

## Request lifecycle

1. `sessionMiddleware` resolves the `gsm_session` cookie (looked up by its HMAC) or a `gsm_api_`
   bearer token into `c.var.user` / `c.var.session`.
2. `csrfGuard` requires `X-Gsm-Client: web` on every non-GET request except agent endpoints.
3. Route-level `requireAuth` / `requireRole("admin")` enforce site roles. Instance routes call
   `assertInstancePermission(c, id, permission)` (`modules/instances/access.ts`), which maps the
   user's per-instance role to what the route needs; users without access get 404. Node routes call
   `assertNodeAccess(c, id)` (`modules/nodes/access.ts`): admins and the node's owners pass,
   everyone else gets 404.
4. Services throw `HttpError`; the app-level `onError` maps it (and zod errors) to
   `{ error: { code, message, details } }`.

## Nodes and presence

- Agents authenticate on the WebSocket upgrade with `Authorization: Bearer <nodeId>.<secret>`. Only
  a SHA-256 of the secret is stored.
- On connect the agent sends `hello` (protocol version, agent version, inventory including what it
  found out about Docker). The server refuses mismatched protocol versions with close code 1008,
  then sends `agent.configure` (registry credentials) and emits `agent.hello` on the event bus.
- `metrics` events double as heartbeats. `offline-detector` marks a node offline after Settings →
  General → offline seconds without one; a closed socket marks it offline immediately.
- Enrollment reattaches by `/etc/machine-id`, so reinstalling the agent does not duplicate nodes.
- Every node has a **port pool** (`portRangeStart..portRangeEnd`, default 30000–30999) and a bind
  address. Creating an instance reserves one host port per template port in `instance_ports` (unique
  per node); an operator can pick specific ports. The node's public address (for players) defaults
  to the address the agent connects from.

## Templates

A template (`shared/src/api/templates.ts`, `TemplateDefinition`) says how to install and run one
kind of server: the runtime image (and alternatives), an install script and its resolver, the
startup command, typed variables, ports, config files kept in step with the variables, stop
behaviour, the console "ready" pattern and, optionally, how to see and manage players (see Players
below). Built-ins under `templates/*.json` are seeded on start (`modules/templates/seed.ts`): a
changed file bumps the row's `revision`. Built-ins cannot be edited; copy one to customise. Custom
templates are stored the same way with `builtin = false`.

**Version sources** (`GET /templates/versions?source=`) list game versions for `version` variables:
`minecraft:vanilla` from Mojang's manifest, `minecraft:forge` and `minecraft:neoforge` from their
Maven metadata for a parent Minecraft version. **Install resolvers** turn variables into download
URLs for the install script (`SERVER_JAR_URL`, `INSTALLER_URL`) right before an install runs, so
templates never hard-code URLs. Both are in `modules/templates/versions.ts` and cached.

## Instances

An instance is one container on one node. The server keeps the row (name, node, template, image,
variables, limits, ports, access) and builds an `InstanceSpec` (`shared/src/protocol/instances.ts`)
for every operation so the agent never has to remember configuration: it holds only the container,
the data directory `<dataDir>/instances/<uuid>` (mounted at `/data`) and the console log.

- **Environment**: the instance's variables, plus `GSM_INSTANCE_UUID`, `GSM_INSTANCE_NAME`,
  `GSM_MEMORY_MB`, `GSM_HEAP_MB` (`heapForMemory`), `GSM_PORT_<NAME>` per port and `GSM_BIND`.
  `{{VAR}}` placeholders in the startup command and config file values are substituted by the server
  (`substitute`).
- **Install** runs the template's script in a one-off container as the instance user
  (`inst.install`, output streamed as the `install` console stream) with the data directory mounted;
  success writes the `.gsm-installed` marker and sets `installedAt`. Status is `installing` /
  `install_failed` meanwhile.
- **Start** creates the container (`inst.start`): image, env, published ports on the node's bind
  address, memory and CPU limits, `--user 1500:1500`, restart policy off (the agent handles crash
  restarts itself so it can tell a crash from a stop). Status goes `starting`, then `running` when a
  console line matches the ready pattern (or straight away without one).
- **Stop** types the stop command into the console, waits `timeoutSeconds`, then sends the signal
  and finally kills (`inst.stop`). `kill` skips straight to SIGKILL.
- **Console**: the agent attaches to the container's stdio, batches lines into `inst.console` events
  and appends them to `<dataDir>/logs/<uuid>/console.log` (rotated). The server keeps the last N
  lines per instance in memory (Settings → General) and fans them out to browsers that subscribed
  over `/ws/ui`; `GET /instances/:id/console` reads the tail from the node's log file.
- **Stats** arrive every 10 s (`inst.stats`), are kept on the row (`lastStats`) and pushed as
  `instance.stats`.
- **Reconciliation**: after every `agent.hello` the supervisor (`modules/instances/supervisor.ts`)
  asks `inst.list` and folds the states into the rows, starts instances with `autoStart` that are
  stopped, and marks instances `unknown` when their node goes offline.
- **Access**: `instance_users` holds `(instance, user, role)` and `node_users` `(node, user)`: a
  node's owners manage it and are `owner` of every instance on it. Admins see everything; users see
  only their instances and nodes (lists, the UI socket, and `myRole` on every DTO). Changing access,
  or creating an instance on an owned node, closes the user's UI sockets so they reconnect with the
  new scope.

## Files and backups

The file manager proxies `fs.*` to the agent, which confines every path to the instance's data
directory (no `..`, symlinks resolved and checked). Uploads and downloads never ride the control
socket: the server offers a one-time transfer token; the agent GETs an upload's bytes from
`/api/v1/agents/transfers/:token` (and checks the SHA-256 the server counted) or POSTs a download's
bytes there. Every read of contents and every change is audited on the instance.

Backups are `.tar.gz` archives under `<dataDir>/backups/<uuid>/` made by the agent (`backup.create`,
progress streamed), recorded in `backups` with size and SHA-256. Restoring requires a stopped
instance. Downloads go through the same transfer relay.

## Players

A template may declare a `players` section (`TemplatePlayers` in `shared/src/api/templates.ts`); the
built-in Minecraft templates do. The agent knows nothing about players: the server reads them out of
the console stream it already receives, and acts with `inst.command` and `fs.read`. The code is in
`modules/players/` (`parse.ts` is the pure part).

- **Online**: every `inst.console` batch of the game stream is matched against the template's
  `join`, `leave` and `identify` patterns, strictly in order per instance, and folded into
  `instance_players` (one row per instance and name; names compare case-insensitively). A line
  matching `list.pattern` is the whole truth and replaces the online set. Minecraft uses the
  `… logged in with entity id` and `… lost connection:` lines (they carry the plain name, unlike
  "joined the game"), anchored to the log prefix so chat cannot imitate them, and `list uuids`.
- **Resync**: stopping, crashing, starting and installing mark everyone offline. After every agent
  hello the supervisor types the template's `list.command` into each running instance, because
  console lines sent while the node was away are lost; the Players tab's Refresh does the same.
- **Recent players** are offline rows seen in the last 30 days; housekeeping forgets them after 90.
- **Lists** (operators, bans, whitelist) are files in the instance, read with `fs.read` as `json`
  arrays or plain `lines`, cached for 30 s and read again when a console line matches
  `console.refresh` or an action ran. A missing file is an empty list.
- **Actions** are one console command each, with `{{PLAYER}}`, `{{PLAYER_ID}}` and field
  placeholders. The server checks the name against `namePattern` (which keeps out selectors such as
  `@a`) and each field against its type, refuses line breaks, and drops an empty optional field with
  the space before it. `online` limits an action to online players and `when` to players on (or not
  on) a list, so Ban and Unban, Op and Deop show one at a time.
- Browsers get `instance.players` after each change; `InstanceDto.players.online` is the count, kept
  in memory and loaded at start.

## Single-node assumptions

Background loops, console buffers, player tracking and the in-memory agent registry assume one
server process. Horizontal scaling would need a shared pub/sub for UI events and a distributed lock
for loops.
