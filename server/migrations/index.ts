/** Ordered list of migrations. Append new entries; never reorder or rename applied ones. */
import type { Migration } from "../src/db/migrate.ts";
import * as m0001 from "./0001-settings.ts";
import * as m0002 from "./0002-auth.ts";
import * as m0003 from "./0003-releases.ts";
import * as m0004 from "./0004-nodes.ts";
import * as m0005 from "./0005-templates.ts";
import * as m0006 from "./0006-instances.ts";
import * as m0007 from "./0007-backups.ts";
import * as m0008 from "./0008-players.ts";
import * as m0009 from "./0009-node-users.ts";
import * as m0010 from "./0010-sftp.ts";

export const migrations: Migration[] = [
  { name: "0001-settings", ...m0001 },
  { name: "0002-auth", ...m0002 },
  { name: "0003-releases", ...m0003 },
  { name: "0004-nodes", ...m0004 },
  { name: "0005-templates", ...m0005 },
  { name: "0006-instances", ...m0006 },
  { name: "0007-backups", ...m0007 },
  { name: "0008-players", ...m0008 },
  { name: "0009-node-users", ...m0009 },
  { name: "0010-sftp", ...m0010 },
];
