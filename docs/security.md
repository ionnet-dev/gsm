# Security model

GSM starts and stops game servers, edits their files and hands out console access on every node, and
its agent runs as root with the Docker socket, so the web app must be treated as an administrative
console. This page lists what protects it and what the operator must still do.

## Browser sessions

- Email + password (argon2id, 64 MiB / 3 iterations). A dummy verify runs for unknown accounts so
  timing does not reveal whether an email exists.
- The `gsm_session` cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `SITE_URL` is https.
  Sessions last 7 days, sliding.
- Session ids are stored as `HMAC-SHA256(SESSION_SECRET, cookie)`. A database dump does not yield
  usable sessions; rotating `SESSION_SECRET` signs everyone out.
- Changing your password signs out your other sessions. An admin resetting a password, disabling a
  user or turning off their 2FA signs out all of that user's sessions.
- Every non-GET request needs the `X-Gsm-Client: web` header (CSRF defence: cross-site forms cannot
  add it). WebSocket upgrades check `Origin` against `SITE_URL`.
- Login is rate limited per source IP (20 / 15 min) **and** per account (10 / 15 min).
- A Content-Security-Policy restricts scripts to the same origin and forbids framing.

## Forgotten passwords and two-factor authentication

Unchanged from the design GSM inherited: emailed one-time reset links (token only in the URL
fragment, SHA-256 stored, 30 minutes, single use), authenticator apps (TOTP, seed sealed with
AES-256-GCM under a key derived from `SESSION_SECRET`), email codes (need SMTP), and ten one-time
recovery codes. An administrator can turn a user's 2FA off from Settings → Users, or on the server
with `deno task 2fa:reset <email>`. Rotating `SESSION_SECRET` makes stored authenticator seeds
unreadable.

API tokens are minted from an authenticated browser session and act with the owner's role and
instance access; treat them like passwords (they can be revoked under My account).

## Roles

- `admin` manages nodes, templates, users, settings and every instance.
- `user` sees nothing but the instances they were given access to and the nodes an admin made them
  owner of. On each instance their role is `owner` (everything, including sharing and deleting),
  `operator` (start, stop, console commands, files, backups, settings, player actions) or `viewer`
  (watch the console, the status and who is online).

An admin can make a user **owner of a node**. A node owner manages that node (name, addresses, port
pool, images, ping and inventory refresh), creates instances on it and is `owner` of every instance
on it, including instances created later. Deleting the node, changing its owners, enrollment tokens,
agent releases and templates stay with admins. Owning a node gives no shell on the machine: it adds
up to what an instance owner can do (below) on every instance there, plus pulling and removing
Docker images on it.

A user's UI socket is closed and reopened when their instance or node access changes, so live events
never leak across a revoked grant. Instances a user cannot see answer 404, so ids cannot be probed.

What access to an instance means in practice:

- **Console commands** are commands to the game server, with whatever the game allows.
- **Files** are read and written inside the instance's own directory only; the agent refuses paths
  and symlinks that leave it. Files are owned by uid 1500 (the container user), never root.
- The **startup command** and **install script** run inside the instance's container: the startup
  command and the install script both as uid 1500 with the instance's directory mounted (the install
  in a one-off container). An owner, who can edit the startup override, or an admin editing a
  template can therefore run arbitrary code _inside a container on the node_ with the instance's
  files, memory and CPU limits, but not on the node itself. Only admins edit templates.
- **Backups** are archives of the instance directory, stored on the node and downloadable through
  the panel.
- **Player actions** (kick, ban, op, …) are console commands from the template, so they allow
  nothing a console command would not. Player names must match the template's name pattern (no
  `@a`-style selectors), values may not contain line breaks, and each action is audited with the
  command it typed. The Players tab reads the game's list files (operators, bans, whitelist) without
  a `file.view` entry per read; viewers are not shown those lists.

## Agents and nodes

Agents authenticate with `<nodeId>.<secret>`; only a SHA-256 of the secret is stored and compared in
constant time. Enrollment tokens are exchanged once per install (rate limited per IP), can be
limited by expiry and use count, and should be revoked once the install is done. Re-enrolling with
the same `/etc/machine-id` re-attaches the existing node and rotates its secret.

The agent runs as root and uses the Docker socket: it creates containers with bind mounts of
`/var/lib/gsm/instances/<uuid>`, published ports on the node's bind address, memory and CPU limits
and `--user 1500:1500`. It never mounts anything outside `/var/lib/gsm`, never runs privileged
containers, and refuses instance operations for uuids it did not create through the server. Registry
credentials from Settings → Registry are sent to every agent over the authenticated socket and kept
in memory only.

File transfers are authenticated the same way: `/api/v1/agents/transfers/:token` needs the node's
credentials _and_ a one-time token the server issued to that node for one transfer. Each side checks
the other's SHA-256 before a file is renamed into place or a download completes.

## Reverse proxy and `TRUST_PROXY`

GSM expects a TLS-terminating reverse proxy. The client IP used for rate limiting and the audit log
is the **last** `X-Forwarded-For` hop, which is the one your proxy appends. If clients reach the
server directly (no proxy), set `TRUST_PROXY=false`, otherwise the header is attacker-controlled and
the per-IP limits can be side-stepped (the per-account limits still apply). Bind the container to
localhost (`BIND_HOST=127.0.0.1`, the default) so only the proxy can reach it.

## Things to know

- SMTP credentials and registry credentials are stored in the database in plain text (they must be
  sent in the clear to the upstream service). Protect database backups accordingly.
- `/api/v1/health` reports only `status` and `db` to anonymous callers; `/install.sh` and the agent
  binaries are public by design.
- All state changes are recorded in the audit log, including failed logins, wrong codes and every
  file read or change on an instance. The log is kept forever unless an administrator sets a limit
  under Settings → General → History.
