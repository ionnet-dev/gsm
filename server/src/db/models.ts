/**
 * Imports every model (registering it with Sequelize) and wires associations in one place,
 * so module model files never import each other at runtime.
 */
import { Setting } from "../modules/settings/models.ts";
import { User } from "../modules/users/models.ts";
import { LoginChallenge, PasswordReset, RecoveryCode, Session } from "../modules/auth/models.ts";
import { ApiToken } from "../modules/auth/tokens.ts";
import { AuditEntry } from "../modules/audit/models.ts";
import { AgentRelease } from "../modules/releases/models.ts";
import { EnrollmentToken, Node } from "../modules/nodes/models.ts";
import { Template } from "../modules/templates/models.ts";
import { Backup, Instance, InstancePort, InstanceUser } from "../modules/instances/models.ts";

Session.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(Session, { as: "sessions", foreignKey: "userId" });
LoginChallenge.belongsTo(User, { as: "user", foreignKey: "userId" });
RecoveryCode.belongsTo(User, { as: "user", foreignKey: "userId" });
PasswordReset.belongsTo(User, { as: "user", foreignKey: "userId" });

AuditEntry.belongsTo(User, { as: "actor", foreignKey: "actorUserId" });
ApiToken.belongsTo(User, { as: "user", foreignKey: "userId" });
AgentRelease.belongsTo(User, { as: "creator", foreignKey: "createdBy" });

EnrollmentToken.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
Node.belongsTo(EnrollmentToken, { as: "enrollmentToken", foreignKey: "enrollmentTokenId" });

Template.belongsTo(User, { as: "creator", foreignKey: "createdBy" });

Instance.belongsTo(Node, { as: "node", foreignKey: "nodeId" });
Node.hasMany(Instance, { as: "instances", foreignKey: "nodeId" });
Instance.belongsTo(Template, { as: "template", foreignKey: "templateId" });
Template.hasMany(Instance, { as: "instances", foreignKey: "templateId" });
Instance.belongsTo(User, { as: "creator", foreignKey: "createdBy" });
Instance.hasMany(InstancePort, { as: "ports", foreignKey: "instanceId" });
InstancePort.belongsTo(Instance, { as: "instance", foreignKey: "instanceId" });
InstancePort.belongsTo(Node, { as: "node", foreignKey: "nodeId" });
Instance.hasMany(InstanceUser, { as: "access", foreignKey: "instanceId" });
InstanceUser.belongsTo(Instance, { as: "instance", foreignKey: "instanceId" });
InstanceUser.belongsTo(User, { as: "user", foreignKey: "userId" });
User.hasMany(InstanceUser, { as: "instanceAccess", foreignKey: "userId" });
Backup.belongsTo(Instance, { as: "instance", foreignKey: "instanceId" });
Instance.hasMany(Backup, { as: "backups", foreignKey: "instanceId" });
Backup.belongsTo(User, { as: "creator", foreignKey: "createdBy" });

export {
  AgentRelease,
  ApiToken,
  AuditEntry,
  Backup,
  EnrollmentToken,
  Instance,
  InstancePort,
  InstanceUser,
  LoginChallenge,
  Node,
  PasswordReset,
  RecoveryCode,
  Session,
  Setting,
  Template,
  User,
};
