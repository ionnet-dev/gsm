# Wire protocol

All WebSocket traffic uses one JSON envelope. Source of truth: `shared/src/protocol/envelope.ts`
(zod) mirrored in `agent/internal/protocol/`. `shared/fixtures/hello.json` and
`shared/fixtures/instance-spec.json` are parsed by both sides' tests.

```jsonc
{ "t": "req",    "id": "a1", "method": "inst.start", "params": { ... } }
{ "t": "res",    "id": "a1", "ok": true,  "result": { ... } }
{ "t": "res",    "id": "a1", "ok": false, "error": { "code": "timeout", "message": "..." } }
{ "t": "stream", "id": "a1", "seq": 0, "chunk": { ... } }          // tied to the request id
{ "t": "stream", "id": "a1", "seq": 7, "chunk": null, "done": true } // always sent before the res
{ "t": "event",  "event": "metrics", "data": { ... } }
```

Rules

- `PROTOCOL_VERSION` is 1. `hello.protocolVersion` must match or the server closes the socket.
- Every request has a timeout (server default 30 s; installs, starts and transfers get more).
- A stream ends with `done: true` before the final `res`.
- Error codes: `unknown_method`, `invalid_params`, `timeout`, `cancelled`, `unauthorized`,
  `unavailable`, `internal`, `not_found`.

## Server → agent methods

Schemas: `shared/src/protocol/agent.ts` (`agentMethods`). Params and results are the zod schemas
named there; this table is the overview.

| Method                    | Params                                 | Result / stream                                                             |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `agent.ping`              | `{}`                                   | `{ at, agentVersion }`                                                      |
| `agent.configure`         | `AgentConfigureParams`                 | `{ sftp?, firewall? }`, see SFTP and Firewall; after hello and changes      |
| `agent.update`            | `{ version, path, sha256 }`            | `{ replaced, message }`; the agent restarts into the new binary             |
| `sys.inventory`           | `{}`                                   | `Inventory`                                                                 |
| `inst.list`               | `{}`                                   | `{ instances: InstanceState[] }` — every container labelled `gsm.instance`  |
| `inst.status`             | `{ uuid }`                             | `InstanceState`                                                             |
| `inst.install`            | `{ spec, install }`                    | stream `{ lines: ConsoleLine[] }`; result `{ exitCode, durationMs }`        |
| `inst.start`              | `{ spec }`                             | `InstanceState`                                                             |
| `inst.stop`               | `{ uuid, force }`                      | `InstanceState` (after the exit)                                            |
| `inst.restart`            | `{ spec }`                             | `InstanceState`                                                             |
| `inst.command`            | `{ uuid, command }`                    | `{}` — written to the game's stdin, or its console transport                |
| `inst.consoleTail`        | `{ uuid, stream, lines }`              | `{ lines: ConsoleLine[] }` from the node's log file                         |
| `inst.remove`             | `{ uuid, deleteFiles }`                | `{}`                                                                        |
| `inst.stats`              | `{ uuids }`                            | `{ stats: InstanceStats[] }`                                                |
| `db.dump`                 | `{ uuid, database, path }`             | `{ path, size }`: a gzipped SQL dump written into the instance's files      |
| `db.import`               | `{ uuid, database, path }`             | `{}`: the database emptied, then filled from a `.sql` or `.sql.gz` file     |
| `fs.list` … `fs.download` | see `files.ts`                         | paths are relative to the instance root; see `docs/architecture.md` → Files |
| `backup.create`           | `{ uuid, backupId, ignore, database }` | stream `{ bytes, files }`; result `{ size, sha256, files }`                 |
| `backup.restore`          | `{ uuid, backupId, wipe, database }`   | stream `{ bytes, files }`; result `{ files }`                               |
| `backup.delete`           | `{ uuid, backupId }`                   | `{}`                                                                        |
| `backup.download`         | `{ opId, token, uuid, backupId }`      | `{ size, sha256 }` after posting the bytes                                  |
| `backup.list`             | `{ uuid }`                             | `{ backups: [{ backupId, size, mtime }] }`                                  |
| `image.list`              | `{}`                                   | `{ images: ImageInfo[] }`                                                   |
| `image.pull`              | `{ ref }`                              | stream `PullProgress`; result `{ ref, id }`                                 |
| `image.remove`            | `{ ref }`                              | `{}`                                                                        |
| `sftp.sessions`           | `{ userIds? }`                         | `{ sessions: SftpSession[] }` — open SFTP connections                       |
| `sftp.disconnect`         | `{ ids }`                              | `{ closed }`                                                                |
| `net.probe`               | `ProbeParams`                          | stream `ProbeState` once listening; result `ProbeState` (see below)         |
| `fw.apply`                | `{ key, ports }`                       | `{ backend, rules }` (see Firewall below)                                   |

### The instance spec

Every `inst.install`, `inst.start` and `inst.restart` carries the complete `InstanceSpec`
(`shared/src/protocol/instances.ts`): image, startup command, environment, port bindings, bind
address, limits, stop behaviour, ready pattern, console transport, config files to write
(`properties`, `json`, `ini`, `yaml`, `xml-properties` or `source-cfg`), crash policy, the container
user, and since agent 0.6.0 `entrypoint` (null keeps the image's; `[]` runs without one, under
Docker's init), `volumes`, `mounts`, `pull` (`missing` or `always`), `seccompUnconfined` and
`database`. The agent stores the last spec it saw per instance under `<data_dir>/state/` so a
restarted agent can still stop an instance gracefully, but the server is the source of truth and
resends the spec with every start.

### Volumes, host mounts and the database

- `volumes: [{ name, path, seed }]`: the folder `<data_dir>/instances/<uuid>/volumes/<name>` is
  bound at `path`. A missing one is created first (built beside its name and renamed into place);
  with `seed` the agent copies the image's `path` into it from a created container
  (`gsm-seed-<uuid>`), folders and regular files only. A volume folder that resolves anywhere else
  (a symlink) is refused.
- `mounts: [{ hostPath, containerPath, readOnly }]`: bound only when `hostPath`, symlinks resolved,
  lies under a root in the agent config's `host_mounts` (sent as `Inventory.hostMountRoots` in every
  hello). Two mounts on one container path are refused.
- `database: { engine, image, name, user, password, rootPassword, memoryMb }`: before the game
  starts, the agent makes network `gsm-net-<uuid>`, starts `gsm-db-<uuid>` on it with the alias `db`
  and files in `<data_dir>/databases/<uuid>`, waits until it takes TCP connections (the image sets
  itself up with networking off first), makes the database and user match the spec, and puts the
  game's container on the same network. Stopping the instance stops it afterwards; `inst.restart`
  and crashes leave it running; `inst.remove` removes it (and its files with `deleteFiles`). The
  clients run inside that container with the root password in `MYSQL_PWD`, never on a command line.
- `backup.create` with `database` dumps it to `.gsm/database.sql.gz` in the data directory before
  archiving and deletes the file afterwards; `backup.restore` with `database` imports that file when
  the archive had one. `db.dump` and `db.import` start a stopped database for the job and stop it
  again unless the game started meanwhile.

### Console and states

The agent attaches to the container's stdio and batches output into `inst.console` events (`stream`
is `console` for the game and `install` for install runs), appending the same lines to
`<data_dir>/logs/<uuid>/console.log`. State changes go out as `inst.status`:

- `starting` after the container starts; `running` once a line matches the spec's `readyPattern`
  (immediately when there is none);
- `stopping` while a stop is in progress; `stopped` when the container exits after a stop request or
  with code 0;
- `crashed` on any other exit; with `restartOnCrash` the agent restarts it up to three times in ten
  minutes and says so on the console;
- `installing` while an install container runs.

Stopping: the stop command (if any) is typed into stdin (or sent over the console transport), the
agent waits `stop.timeoutSeconds`, then sends `stop.signal` and, ten seconds later, SIGKILL.
`inst.stop` with `force` goes straight to SIGKILL.

### Console transport

With `console.transport` in the spec (`kind` `telnet` or `rcon`, `port`, `password`, `ignore`), the
agent opens a session to `port` on the container's address on its Docker network once the container
runs; the port is never published on the node. It retries every 2 s until the game listens and
reconnects when the session drops; a refused password waits a minute. Telnet: the password answers
the first prompt that mentions it (or goes out after 10 s of silence) and option negotiation is
dropped. RCON is Source RCON: an auth packet, then one exec packet per command. `inst.command` and
the stop command go into the session (`invalid_params` while it is not connected), and every answer
line becomes a game console line, except lines matching `ignore`. The console shows
`[GSM] console connected (telnet)` and a note when the connection is lost.

`fifo` (`path`, port 0) keeps no session: each command runs `sh -c 'cat > "$0"' <path>` in the
container through `docker exec`, as the container's user, with the command line on stdin, and is
refused (`invalid_params`) when `path` is not a named pipe yet rather than creating a file there.
The game's answers are its own stdout.

## Agent → server events

| Event          | Data                                           | When                                                  |
| -------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `hello`        | `{ protocolVersion, agentVersion, inventory }` | on every connection, first                            |
| `metrics`      | `Metrics`                                      | every `metrics_interval` (30 s), doubles as heartbeat |
| `inst.status`  | `InstanceState`                                | on every state change                                 |
| `inst.console` | `{ uuid, stream, lines }`                      | about every 100 ms while output flows                 |
| `inst.stats`   | `{ stats: InstanceStats[] }`                   | every 10 s for running instances                      |
| `agent.log`    | `{ level, message }`                           | notable agent-side events                             |
| `sftp.session` | `SftpSessionEvent`                             | an SFTP sign-in (`opened`) or its end (`closed`)      |

## Agent → server requests

Schemas: `shared/src/protocol/sftp.ts` (`serverMethods`). The agent sends a `req` envelope and the
server answers with `res`; any other method is refused with `unknown_method`.

| Method      | Params                                                       | Result                                     |
| ----------- | ------------------------------------------------------------ | ------------------------------------------ |
| `sftp.auth` | `{ username, method, password?, publicKey?, remoteAddress }` | `{ allowed, userId?, uuid?, credential? }` |

### SFTP

The agent serves SFTP (SSH with the `sftp` subsystem only) on the node's SFTP port, default 2022,
with an ed25519 host key it creates once at `<data_dir>/state/sftp_host_ed25519_key`. Usernames are
`<sftp name>.<first 8 characters of the instance uuid>`. For every password (or keyboard-interactive
answer, sent as `password`) and every key a client offers, the agent asks the server with
`sftp.auth` (10 s timeout; no answer means no) and never caches the answer. An allowed session is
confined to `<data_dir>/instances/<uuid>` with `os.Root`, and what it creates is owned by the
instance's container user. `credential` is opaque to the agent and comes back in `sftp.sessions`:
when someone's access changes, the server re-checks each listed session and closes the ones no
longer allowed with `sftp.disconnect`. `inst.remove` closes the instance's sessions itself.

### Reachability probes

`net.probe` tests ports of a stopped instance from outside. The agent listens on each requested port
and protocol on the node's bind address, streams one `ProbeState` once they are open (a port it
cannot open, because something else has it, comes back `bound: false` with the error), and returns
as soon as every open listener got the token, or after `timeoutMs` (1–15 s). The server sends
`GSM-PROBE <token>` to the node's public address, as a line over TCP and as datagrams over UDP; the
agent answers `GSM-PROBE-OK` and ignores anything else. Running servers are not probed: their TCP
ports are simply connected to.

### Firewall

With `agent.configure` `firewall: { managed: true }` the agent may change the node's firewall. It
uses whichever of ufw and firewalld is active (fixed commands, no shell) and keeps the rules it
added in `<data_dir>/state/firewall.json`, per key: `sftp` for the SFTP port, whose rule follows the
SFTP port while management is on, and `instance:<uuid>` for `fw.apply`, which makes an instance's
rules exactly `ports` (`[]` removes them). A rule that is already there (any rule allowing the port
from anywhere) is reported as `existing` and never removed. Each wanted rule comes back `open`,
`existing` or `error`. With `managed: false` nothing is opened, and every rule the agent added is
removed; `inst.remove` removes the instance's rules. The configure answer reports `backend` (`ufw`,
`firewalld` or null), `error` (a firewall that could not be asked, e.g. without root) and the SFTP
rule.

## Transfers

File bytes never ride the control socket. For an upload the server offers a one-time token; the
agent `GET`s `/api/v1/agents/transfers/:token` (with its bearer token), writes the file beside its
destination, `GET`s `…/:token/digest` for the SHA-256 the server counted and renames the file into
place only if it matches. For a download the agent `POST`s the bytes to the same URL and the server
answers with the SHA-256 it received, which the agent compares with its own. Unclaimed tokens expire
after a minute; a stalled stream fails after two.
