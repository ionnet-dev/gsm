import { z } from "zod";
import { Inventory } from "@gsm/shared";

export {
  CreateEnrollmentTokenBody,
  GrantNodeAccessBody,
  ListNodesQuery,
  UpdateNodeBody,
} from "@gsm/shared";

export const EnrollBody = z.object({
  token: z.string().min(1).max(200),
  name: z.string().min(1).max(120).optional(),
  agentVersion: z.string().max(32),
  inventory: Inventory,
});
