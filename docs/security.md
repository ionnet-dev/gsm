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
  and symlinks that leave it. Files are owned by the container user (uid 1500, or the template's
  user), never root. A template's volumes are folders of that directory too; the agent refuses to
  mount one that has been turned into a symlink.
- The **startup command** and **install script** run inside the instance's container: the startup
  command and the install script both as the container user with the instance's directory mounted
  (the install in a one-off container). An owner, who can edit the startup override, or an admin
  editing a template can therefore run arbitrary code _inside a container on the node_ with the
  instance's files, memory and CPU limits, but not on the node itself. Only admins edit templates.
- **Container options** are template settings, so only admins choose them: another entrypoint, user
  (never root), pulling on every start, and `seccompUnconfined`, which turns Docker's seccomp filter
  off for that container (32-bit Source servers need it on some Docker hosts). The container still
  runs unprivileged without added capabilities, but every system call is allowed; prefer a 64-bit
  build where the game has one.
- **Host mounts** put a node directory into one instance's container. Only admins set them, and only
  below the directories the node's own agent config lists under `host_mounts`; with none listed (the
  default) nothing can be mounted, so not even a compromised panel can mount the node's root or the
  Docker socket. Mount read-only where you can; what the container writes there is owned by its uid.
- A **database** runs in its own container on a network only the instance's container shares; no
  port is published. The game's password is shown to owners and operators (Database tab) and is in
  the game's own config, like any credential a game reads. Both database passwords are derived from
  `SESSION_SECRET` and the instance, so none is stored; changing `SESSION_SECRET` changes them, and
  existing databases then refuse the new ones until an admin resets them by hand.
- **Backups** are archives of the instance directory, stored on the node and downloadable through
  the panel.
- **Player actions** (kick, ban, op, …) are console commands from the template, so they allow
  nothing a console command would not. Player names must match the template's name pattern (no
  `@a`-style selectors), values may not contain line breaks, and each action is audited with the
  command it typed. The Players tab reads the game's list files (operators, bans, whitelist) without
  a `file.view` entry per read; viewers are not shown those lists.

## SFTP

Each node's agent serves SFTP on one port (default 2022, set per node; null turns it off). Only the
`sftp` subsystem is offered: no shell, exec, port forwarding or other channels. Signing in needs the
`files` permission on the instance (owner or operator, admins and node owners included), checked by
the server on every sign-in, and either:

- the user's **SFTP password for that instance**, made on its Files tab, shown once, stored as an
  argon2id hash and separate from the panel password, so panel two-factor keeps its meaning; or
- one of the user's **SSH keys** (My account), ed25519, ECDSA or RSA of at least 2048 bits.

The panel password never works over SFTP. Twenty failed passwords from one address, or for one
username, lock password sign-ins for ten minutes. The agent confines every session to the instance's
directory with `os.Root`, so neither `..` nor symlinks reach outside it, refuses to create symlinks
and hard links, and creates files as the container user. When access changes (a grant, a role, node
ownership, a disabled or deleted user, a new SFTP password, a removed key), the server re-checks the
open sessions and closes the ones no longer allowed. Sessions are audited when they open and when
they close (with how many files were uploaded, downloaded, removed and renamed); single SFTP
operations are not audited one by one, unlike the web file manager. SFTP needs the node connected to
the server, since the agent asks the server about every sign-in.

Reachability checks make the panel server open outgoing connections to the node's public address on
the instance's ports and the SFTP port. For a stopped instance the agent listens on those ports for
at most 15 seconds, only when the server asks (`net.probe`), and reacts to nothing but the one-time
token. Only owners and operators (and node owners, admins) can start a check.

The agent changes the node's firewall only when the node's "Manage firewall" switch is on (admins
and the node's owners set it) and only for an instance's own ports, when one of its owners asks,
plus the SFTP port. It runs `ufw` or `firewall-cmd` with fixed arguments (no shell), remembers the
rules it added and never removes a rule that was there before. Turning the switch off, deleting an
instance or changing its ports removes the rules it added; removing works even while the switch is
off, opening does not.

## Agents and nodes

Agents authenticate with `<nodeId>.<secret>`; only a SHA-256 of the secret is stored and compared in
constant time. Enrollment tokens are exchanged once per install (rate limited per IP), can be
limited by expiry and use count, and should be revoked once the install is done. Re-enrolling with
the same `/etc/machine-id` re-attaches the existing node and rotates its secret.

The agent runs as root and uses the Docker socket: it creates containers with bind mounts of
`/var/lib/gsm/instances/<uuid>` (and folders in it), published ports on the node's bind address,
memory and CPU limits and `--user 1500:1500` (or a template's user, never root). It mounts nothing
outside `/var/lib/gsm` except host mounts under the `host_mounts` roots of its own config, never
runs privileged containers, and refuses instance operations for uuids it did not create through the
server. Database containers run the official MariaDB image as it is (its entrypoint starts as root
and drops to its own user) with their files in `/var/lib/gsm/databases/<uuid>`. Registry credentials
from Settings → Registry are sent to every agent over the authenticated socket and kept in memory
only.

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
