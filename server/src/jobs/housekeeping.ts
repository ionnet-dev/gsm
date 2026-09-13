/**
 * Low-frequency maintenance: expired sessions, 2FA challenges and password reset links. Retention
 * has its own loops.
 */
import { log } from "../lib/logger.ts";
import { purgeExpiredSessions } from "../modules/auth/service.ts";
import { purgeExpiredResets } from "../modules/auth/password-reset.ts";
import { purgeExpiredChallenges } from "../modules/auth/two-factor.ts";

const hlog = log.child("housekeeping");

export function startHousekeeping(): () => void {
  const tick = async () => {
    try {
      const sessions = await purgeExpiredSessions();
      if (sessions) hlog.debug("purged expired sessions", { sessions });
      const challenges = await purgeExpiredChallenges();
      if (challenges) hlog.debug("purged expired login challenges", { challenges });
      const resets = await purgeExpiredResets();
      if (resets) hlog.debug("purged expired password reset links", { resets });
    } catch (err) {
      hlog.error("tick failed", { err });
    }
  };
  tick();
  const timer = setInterval(tick, 60 * 60 * 1000);
  return () => clearInterval(timer);
}
