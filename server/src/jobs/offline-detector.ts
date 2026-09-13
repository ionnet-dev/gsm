/**
 * Marks nodes offline when no heartbeat (metrics) has arrived for several intervals, even if the
 * socket looks open (half-open TCP after a network drop). Also closes such stale sockets.
 */
import { Op } from "sequelize";
import { Node } from "../db/models.ts";
import { log } from "../lib/logger.ts";
import * as nodes from "../modules/nodes/service.ts";
import { getGeneral } from "../modules/settings/service.ts";
import { agentGateway } from "../ws/agent-gateway.ts";

const dlog = log.child("offline-detector");
const CHECK_EVERY_MS = 15_000;

export function startOfflineDetector(): () => void {
  const tick = async () => {
    try {
      const { offlineAfterSeconds } = await getGeneral();
      const stale = await Node.findAll({
        attributes: ["id", "name"],
        where: {
          status: { [Op.ne]: "offline" },
          [Op.or]: [{ lastSeenAt: null }, {
            lastSeenAt: { [Op.lt]: new Date(Date.now() - offlineAfterSeconds * 1000) },
          }],
        },
      });
      for (const n of stale) {
        dlog.warn("no heartbeat, marking offline", { id: n.id, name: n.name });
        agentGateway.disconnect(n.id, "heartbeat timeout");
        await nodes.setStatus(n.id, "offline");
      }
    } catch (err) {
      dlog.error("tick failed", { err });
    }
  };
  const timer = setInterval(tick, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
