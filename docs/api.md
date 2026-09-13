# REST API

All routes live under `/api/v1`. Errors are always `{ error: { code, message, details? } }`. Every
non-GET request from a browser needs `X-Gsm-Client: web` (CSRF); personal API tokens
(`Authorization: Bearer gsm_api_…`) are exempt. Request and response shapes are the DTOs and zod
schemas in `shared/src/api/*`.

Roles: site-wide `admin` or `user` (`ROLES`); per instance `owner`, `operator`, `viewer`
(`INSTANCE_ROLES`, permissions in `INSTANCE_PERMISSIONS`). Admins may do everything. A `user`
without access to an instance gets 404 for it, with access but not the permission 403. An admin can
make a `user` owner of a node: they manage that node and are `owner` of every instance on it,
including instances created later.

## Auth, users, settings, audit (ported from the fleet console)

| Method       | Path                                                       | Who     | Notes                                                        |
| ------------ | ---------------------------------------------------------- | ------- | ------------------------------------------------------------ |
| GET          | `/health`                                                  | anyone  | `{ status, db }`; version and migrations when signed in      |
| GET          | `/auth/status`                                             | anyone  | `AuthStatus`                                                 |
| POST         | `/auth/setup`                                              | anyone  | first admin, only while there are no users                   |
| POST         | `/auth/login`, `/login/verify`, `/login/resend`, `/logout` |         | see `shared/src/api/auth.ts`                                 |
| GET          | `/auth/me`                                                 | user    |                                                              |
| POST         | `/auth/password`, `/password/forgot`, `/password/reset`    |         |                                                              |
| \*           | `/auth/2fa/…`, `/auth/tokens…`                             | user    | second factors, personal API tokens                          |
| GET          | `/users/directory`                                         | user    | `{ items: [{ id, name, email, role }] }` for sharing pickers |
| GET/POST     | `/users`                                                   | admin   | `{ items: PublicUser[] }` (with `instanceCount`)             |
| PATCH/DELETE | `/users/:id`, POST `/users/:id/password`                   | admin   |                                                              |
| GET          | `/audit?page&pageSize&action&actorUserId`                  | admin   | `Page<AuditEntry>`                                           |
| GET          | `/audit/export?format=csv                                  | jsonl`  | admin                                                        |
| GET          | `/settings`                                                | admin   | `{ general, history, files, smtp, registry }`                |
| PUT          | `/settings/general                                         | history | files                                                        |
| POST         | `/settings/smtp/test`                                      | admin   | `{ to }`                                                     |
| GET          | `/agent-releases`                                          | admin   | `{ items: AgentReleaseDto[], summary }`                      |
| POST         | `/agent-releases`                                          | admin   | multipart: file, version, arch, notes, makeLatest            |
| POST         | `/agent-releases/:id/latest`, DELETE `/agent-releases/:id` | admin   |                                                              |
| POST         | `/agent-releases/rollout`                                  | admin   | `{ updated: number[], failed: number[], skipped }`           |

## Nodes and enrollment

Admins manage every node. A node's owners may use every node route below except deleting the node
and changing its owners; lists and summaries only hold the nodes the requester manages, and other
nodes answer 404. Enrollment tokens are admin only. `PATCH /nodes/:id` also takes `sftpPort` (null
turns SFTP off; it must lie outside the port pool and not be an instance's port).

| Method   | Path                                | Notes                                                                                                  |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET      | `/nodes?page&pageSize&status&q`     | `Page<NodeDto>`                                                                                        |
| GET      | `/nodes/all`                        | `{ items: NodeDto[] }` for pickers                                                                     |
| GET      | `/nodes/summary`                    | `NodeSummary`                                                                                          |
| GET      | `/nodes/:id`                        | `{ node: NodeDetailDto, connected }`                                                                   |
| PATCH    | `/nodes/:id`                        | `UpdateNodeBody` → `{ node }`                                                                          |
| DELETE   | `/nodes/:id`                        | admin; refused (409) while it hosts instances                                                          |
| POST     | `/nodes/:id/ping`                   | `{ at, agentVersion, rttMs }`                                                                          |
| POST     | `/nodes/:id/refresh`                | re-reads the inventory → `{ node }`                                                                    |
| GET      | `/nodes/:id/images`                 | `{ images: ImageInfo[] }` live from the agent                                                          |
| POST     | `/nodes/:id/images/pull`            | `{ ref }` → 202; progress arrives as `image.pull` events                                               |
| DELETE   | `/nodes/:id/images?ref=`            |                                                                                                        |
| GET      | `/nodes/:id/access`                 | `{ items: NodeAccessDto[] }`, the node's owners                                                        |
| PUT      | `/nodes/:id/access`                 | admin; `GrantNodeAccessBody` → `{ items }`; owner of the node and every instance on it                 |
| DELETE   | `/nodes/:id/access/:userId`         | admin → `{ items }`                                                                                    |
| GET/POST | `/enrollment-tokens`                | `{ items: EnrollmentTokenDto[] }`; POST `CreateEnrollmentTokenBody` → `{ token, plaintext }`           |
| POST     | `/enrollment-tokens/:id/revoke`     |                                                                                                        |
| POST     | `/agents/enroll`                    | agent-facing, no session: `{ token, name?, agentVersion, inventory }` → `{ agentToken, nodeId, name }` |
| GET/POST | `/agents/transfers/:token[/digest]` | agent-facing byte relay for uploads and downloads                                                      |

## Templates

| Method | Path                                  | Who   | Notes                                                                                                  |
| ------ | ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/templates`                          | user  | `{ items: TemplateDto[] }` (users see them to read variables; admins and node owners create instances) |
| GET    | `/templates/:id`                      | user  | `{ template: TemplateDetailDto }`                                                                      |
| POST   | `/templates`                          | admin | `{ definition }` → 201 `{ template }`                                                                  |
| PUT    | `/templates/:id`                      | admin | `{ definition }`; refused for built-ins (409)                                                          |
| POST   | `/templates/:id/copy`                 | admin | `{ slug, name }` → a custom copy                                                                       |
| DELETE | `/templates/:id`                      | admin | refused while instances use it                                                                         |
| POST   | `/templates/import`                   | admin | `{ definition }` from a pasted JSON                                                                    |
| GET    | `/templates/:id/export`               | admin | the definition as a JSON download                                                                      |
| GET    | `/templates/versions?source=&parent=` | user  | `{ versions: VersionOption[] }` from the version source (cached 10 min)                                |

## Instances

`myRole` on every DTO is the requester's role. Lists are filtered to the requester's scope.

| Method | Path                                                           | Permission         | Notes                                                                                                                                        |
| ------ | -------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/instances?page&pageSize&nodeId&templateId&status&q&sort&dir` | view               | `Page<InstanceDto>`                                                                                                                          |
| GET    | `/instances/summary`                                           | view               | `InstanceSummary` over the scope                                                                                                             |
| POST   | `/instances`                                                   | admin, node owner  | `CreateInstanceBody` → 201 `{ instance: InstanceDetailDto }`; starts the install unless `install: false`                                     |
| GET    | `/instances/:id`                                               | view               | `{ instance: InstanceDetailDto }`                                                                                                            |
| PATCH  | `/instances/:id`                                               | settings           | `UpdateInstanceBody` → `{ instance }`; variables the role may not edit are refused (403); refused while running for image/ports/limits (409) |
| DELETE | `/instances/:id?keepFiles=1`                                   | delete             | stops, removes the container and (unless kept) files, ports and backups                                                                      |
| POST   | `/instances/:id/power`                                         | power              | `{ action: start                                                                                                                             |
| POST   | `/instances/:id/command`                                       | command            | `{ command }` → `{ ok }`                                                                                                                     |
| POST   | `/instances/:id/reinstall`                                     | reinstall          | wipes nothing; runs the install script again → 202                                                                                           |
| GET    | `/instances/:id/console?stream=console                         | install&lines=500` | console                                                                                                                                      |
| GET    | `/instances/:id/stats`                                         | view               | `{ stats: InstanceStats                                                                                                                      |
| GET    | `/instances/:id/access`                                        | view               | `{ items: InstanceAccessDto[] }`: the node's owners first (`via: "node"`, changed on the node), then grants                                  |
| PUT    | `/instances/:id/access`                                        | access             | `GrantAccessBody` (grant or change role) → `{ items }`                                                                                       |
| DELETE | `/instances/:id/access/:userId`                                | access             |                                                                                                                                              |
| GET    | `/instances/:id/activity?page`                                 | view               | audit entries about the instance                                                                                                             |

### Files (`files` permission), all under `/instances/:id/files`

| Method | Path                                                              | Notes                                                                                                                    |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `?path=`                                                          | `FileListResult`                                                                                                         |
| GET    | `/stat?path=`                                                     | `{ path, entry }`                                                                                                        |
| GET    | `/content?path=`                                                  | `FileReadResult & { limit }` (audited)                                                                                   |
| PUT    | `/content`                                                        | `WriteBody` → `FileWriteResult`; 409 `file_changed` on a stale sha                                                       |
| POST   | `/mkdir`, `/rename`, `/delete`, `/chmod`, `/extract`, `/compress` | shared bodies                                                                                                            |
| PUT    | `/upload?path=&overwrite=`                                        | raw body with Content-Length, streamed to the node → `FileTransferResult`                                                |
| POST   | `/download`                                                       | `PathsBody` → `{ url, filename, archive, size }`; the URL is a one-time `GET /files/downloads/:ticket` bound to the user |
| GET    | `/files/limits`                                                   | (top-level) `FilesSettings`                                                                                              |

### Backups (`backups` permission), under `/instances/:id/backups`

| Method | Path                  | Notes                                                                       |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| GET    | ``                    | `{ items: BackupDto[] }`                                                    |
| POST   | ``                    | `CreateBackupBody` → 202 `{ backup }`; progress via `backup.updated` events |
| POST   | `/:backupId/restore`  | `RestoreBackupBody` → 202; instance must be stopped                         |
| POST   | `/:backupId/download` | `{ url, filename, size }` one-time ticket like a file download              |
| DELETE | `/:backupId`          |                                                                             |

### Players, under `/instances/:id/players`

Only for templates with a `players` section (`InstanceDto.players` is null otherwise).

| Method | Path       | Permission | Notes                                                                                                     |
| ------ | ---------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| GET    | ``         | view       | `InstancePlayersDto`: online and recent players; `lists` and `actions` only with the `players` permission |
| POST   | `/refresh` | players    | reads the lists again and, while running, types the template's list command → `{ ok }`                    |
| POST   | `/actions` | players    | `PlayerActionBody` → `{ ok, command }`; 409 when not running, 400 with per-field `details` for bad values |

### SFTP (`files` permission), under `/instances/:id/sftp`

| Method | Path        | Notes                                                                                                      |
| ------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/`         | `{ sftp: InstanceSftpDto }`: host, port, the requester's username, host key, password state                |
| POST   | `/password` | makes or replaces the requester's SFTP password → `{ password, sftp }` (shown once); not with an API token |
| DELETE | `/password` | → `{ sftp }`                                                                                               |

## SSH keys (the requester's own)

| Method | Path            | Notes                                                                          |
| ------ | --------------- | ------------------------------------------------------------------------------ |
| GET    | `/ssh-keys`     | `{ items: SshKeyDto[] }`                                                       |
| POST   | `/ssh-keys`     | `AddSshKeyBody` (`{ name, publicKey }`) → 201 `{ key }`; not with an API token |
| DELETE | `/ssh-keys/:id` | open SFTP sessions signed in with it close                                     |

## Live updates

`/ws/ui` pushes `uiEvents` (see `shared/src/protocol/ui.ts`). Browsers send
`{ "t": "sub", "instanceId" }` to receive that instance's `instance.console` events and
`{ "t": "unsub", "instanceId" }` to stop. Node events reach admins and the node's owners, template
events admins only; instance events reach users with access to the instance. Close code 4002 means
"reconnect now" (access changed), 4001 that the session ended.

`instance.players` (`{ instanceId, online }`) follows every join, leave, list answer and change to
the game's player lists; the web app patches `InstanceDto.players` and refetches the Players tab.
