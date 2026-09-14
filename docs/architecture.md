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
| `images/`    | Dockerfiles       | `gsm-base` (Debian, user 1500, entrypoint), `gsm-java:<version>`, `gsm-steamcmd`    |
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
`steam:294420` lists 7 Days to Die's public Steam branches from api.steamcmd.net (`public` first,
labelled with the version it carries, then `latest_experimental`, then older ones), falling back to
those two when it cannot be reached; the install script hands the branch to SteamCMD. `steam:4020`
does the same for Garry's Mod, falling back to `public` and `x86-64`.

**Ports** may `follow` another port: such a port is always that port plus one, so a run (7 Days to
Die's game port and the two after it) is allocated as one block of free ports in a row, and only its
first port can be chosen. **Variables** may carry a `group` (a heading in the forms) and, for
`select`, `allowCustom` (the options are suggestions and any value is accepted, like 7 Days to Die's
world). **Config files** are merged by the agent as `properties`, `json`, `ini`, `yaml` or
`xml-properties` (`<property name="…" value="…"/>` elements, 7 Days to Die's serverconfig.xml;
commented-out properties are left alone) or `source-cfg` (`name "value"` lines of a Source engine
.cfg, Garry's Mod's server.cfg: every line setting a name is rewritten, keeping its `//` comment; a
line holding several commands is left alone and the value added at the end, where it wins).

**Console transport.** A game that does not read stdin declares `console.transport`: telnet or
Source RCON on a port inside the container. The agent dials it on the container's Docker address
(the port is never published), signs in with the password (usually `{{GSM_CONSOLE_PASSWORD}}`, an
HMAC of `SESSION_SECRET` and the instance, so it is never stored), sends console commands and the
stop command there, and adds the answers to the console, leaving out lines matching `ignore` (7 Days
to Die repeats its whole log over telnet). A `fifo` transport instead writes each command into a
named pipe inside the container (`path`), for images whose own start script reads its console from
one; the answers arrive on stdout. See `docs/protocol.md` → Console transport.

**Garry's Mod** (`templates/garrys-mod.json`) installs srcds with SteamCMD into `/data/server` and
runs it under `script`: without a terminal srcds holds its output back in large blocks. Its
server.cfg is a `source-cfg` file with `log on`, because the join and leave lines
(`"Name<2><STEAM_0:1:…><>" entered the game`) only come with logging. Who is online comes from
`status;echo ---- end of status`: the rows before the marker line.

## Instances

An instance is one container on one node. The server keeps the row (name, node, template, image,
variables, limits, ports, access) and builds an `InstanceSpec` (`shared/src/protocol/instances.ts`)
for every operation so the agent never has to remember configuration: it holds only the container,
the data directory `<dataDir>/instances/<uuid>` (mounted at `/data`) and the console log.

- **Environment**: the instance's variables, plus `GSM_INSTANCE_UUID`, `GSM_INSTANCE_NAME`,
  `GSM_MEMORY_MB`, `GSM_HEAP_MB` (`heapForMemory`), `GSM_PORT_<NAME>` per port, `GSM_BIND`,
  `GSM_CONSOLE_PASSWORD` and, with a database, `GSM_DB_HOST`, `GSM_DB_PORT`, `GSM_DB_NAME`,
  `GSM_DB_USER` and `GSM_DB_PASSWORD` (empty while it is turned off), then the template's own `env`.
  `{{VAR}}` placeholders in the startup command, config file values and `env` are substituted by the
  server (`substitute`).
- **Install** runs the template's script in a one-off container as the instance user
  (`inst.install`, output streamed as the `install` console stream) with the data directory mounted;
  success writes the `.gsm-installed` marker and sets `installedAt`. Status is `installing` /
  `install_failed` meanwhile.
- **Start** creates the container (`inst.start`): image, env, published ports on the node's bind
  address, memory and CPU limits, `--user 1500:1500` (or the template's user), the volumes and host
  mounts, restart policy off (the agent handles crash restarts itself so it can tell a crash from a
  stop). A database is started first. Status goes `starting`, then `running` when a console line
  matches the ready pattern (or straight away without one).
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

## Prebuilt images, volumes and databases

The platform's images keep a game server under `/data`. A template can also run an image built
elsewhere, with the server baked in and only some folders worth keeping:

- **Container options** (`container`): `entrypoint` replaces the image's (then `sh -c "<startup>"`
  follows; an empty list means none, and Docker's init runs as PID 1), `user` runs the container and
  owns the instance's files as another uid:gid, `pull: "always"` pulls before every start and
  install (for tags such as `latest`; the node's copy is used when the registry cannot be reached)
  and `seccompUnconfined` turns Docker's seccomp filter off (some Docker hosts refuse a socket call
  32-bit Source servers make). `env` adds environment in the image's own names, with placeholders.
- **Volumes** (`volumes`) are folders of the instance mounted elsewhere: `volumes/<name>` in the
  instance's files appears at the volume's `path`. The agent creates a missing one before the
  container starts; with `seed` it first copies what the image has at that path (stock maps) out of
  a created, never started container, owned by the instance user. Deleting the folder fills it again
  on the next start. Being files like any other, volumes show in the file manager and SFTP, outlive
  reinstalls and image updates, and are backed up unless `backup: false` (caches). A volume folder
  that is a symlink is refused: Docker would follow it on the node.
- **Host mounts** (`InstanceDetailDto.mounts`) bind a node directory into one instance. Only admins
  set them, and only under the directories the node's agent config lists in `host_mounts` (reported
  as `Inventory.hostMountRoots`); the agent checks again, symlinks resolved, before every start.
- **Database** (`database`, optionally turned on per instance by a boolean variable `enabledBy`): a
  MariaDB container `gsm-db-<uuid>` on a network `gsm-net-<uuid>` shared only with the game's
  container, which reaches it as `db:3306`. Its files live in `<dataDir>/databases/<uuid>`, outside
  the instance's files. The server derives both passwords from `SESSION_SECRET` and the instance, so
  none is stored; on every start the agent makes the database and the game's user match them. It
  starts before the game, stops after an operator stops it, and keeps running across a restart and
  after a crash. `db.dump` and `db.import` move data between it and a `.sql.gz` in the instance's
  files (starting it for the job when it is down); backups carry a dump and restores import it.

Nothing here reaches an agent older than 0.6.0 (`CONTAINER_OPTIONS_AGENT`): it would ignore what it
does not know, so the server refuses to start such an instance there and asks for an update.
Template definitions saved before these fields existed are read through the schema
(`templates/normalize.ts`), which fills in their defaults.

## Files and backups

The file manager proxies `fs.*` to the agent, which confines every path to the instance's data
directory (no `..`, symlinks resolved and checked). Uploads and downloads never ride the control
socket: the server offers a one-time transfer token; the agent GETs an upload's bytes from
`/api/v1/agents/transfers/:token` (and checks the SHA-256 the server counted) or POSTs a download's
bytes there. Every read of contents and every change is audited on the instance.

SFTP goes to the node directly: the agent serves it on the node's SFTP port and asks the server
about each sign-in (`sftp.auth`, `modules/sftp/`). Usernames are `<sftp name>.<short instance
id>`;
a user signs in with their SFTP password for that instance or one of their SSH keys. See
`docs/protocol.md` → SFTP and `docs/security.md` → SFTP.

Reachability (`modules/reachability/`) checks from the panel server that an instance's ports and its
node's SFTP port answer at the node's public address: TCP connects for a running server, the agent's
`net.probe` listener for a stopped one (the only way to test UDP), and the SSH greeting for SFTP.
Results are stored on the instance and the node and shown next to the address.

The firewall (`modules/firewall/`, agent `internal/firewall`) is opt-in per node: with "Manage
firewall" on, an instance's owners can have the agent open its ports with ufw or firewalld
(`fw.apply`), and the agent keeps the SFTP port open. Opened ports follow port changes.

Backups are `.tar.gz` archives under `<dataDir>/backups/<uuid>/` made by the agent (`backup.create`,
progress streamed), recorded in `backups` with size and SHA-256. Volumes marked `backup: false` are
left out. With a database, the agent puts a dump at `.gsm/database.sql.gz` for the archive (and
removes it afterwards); a restore imports it into the database. Restoring requires a stopped
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
  Answers with a line per player use `list.line`: the lines seen before the one matching
  `list.pattern` make up the answer, and a `count` group that disagrees with them discards it (7
  Days to Die's `lp` ends with "Total of N in the game", like other commands do).
- **Resync**: stopping, crashing, starting and installing mark everyone offline. After every agent
  hello the supervisor types the template's `list.command` into each running instance, because
  console lines sent while the node was away are lost; the Players tab's Refresh does the same.
- **Recent players** are offline rows seen in the last 30 days; housekeeping forgets them after 90.
- **Lists** (operators, bans, whitelist) are files in the instance, read with `fs.read` as `json`
  arrays, plain `lines` or `xml` (the `element` entries under their parent, attributes read like
  keys; 7 Days to Die's serveradmin.xml), cached for 30 s and read again when a console line matches
  `console.refresh` or an action ran. A missing file is an empty list. `idFormat` builds an entry's
  id from several keys (`{{platform}}_{{userid}}`); an entry without a name shows its id.
- **Actions** are one console command each, with `{{PLAYER}}`, `{{PLAYER_ID}}` and field
  placeholders. The server checks the name against `namePattern` (which keeps out selectors such as
  `@a`) and each field against its type, refuses line breaks, and drops an empty optional field with
  the space before it. `online` limits an action to online players and `when` to players on (or not
  on) a list, so Ban and Unban, Op and Deop show one at a time. A placeholder in double quotes
  (`"{{PLAYER}}"`) keeps a value with spaces in one argument; double quotes in it become single
  ones, and an empty optional value drops the quotes too. For someone the console never named,
  `{{PLAYER_ID}}` comes from a list entry of the same name.
- Browsers get `instance.players` after each change; `InstanceDto.players.online` is the count, kept
  in memory and loaded at start.

## Single-node assumptions

Background loops, console buffers, player tracking and the in-memory agent registry assume one
server process. Horizontal scaling would need a shared pub/sub for UI events and a distributed lock
for loops.
