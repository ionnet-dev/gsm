/** Container images on a node. */
import { z } from "zod";

export const ImageInfo = z.object({
  /** The first tag, or the id when untagged. */
  ref: z.string(),
  id: z.string(),
  size: z.number().int().nonnegative(),
  created: z.string().datetime(),
});
export type ImageInfo = z.infer<typeof ImageInfo>;

export const PullProgress = z.object({
  status: z.string(),
  /** Layer id when the status is per layer; "" otherwise. */
  layer: z.string(),
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type PullProgress = z.infer<typeof PullProgress>;

export const imageMethods = {
  "image.list": { params: z.object({}), result: z.object({ images: z.array(ImageInfo) }) },
  /** Pull `ref` (with the registry credentials from agent.configure), streaming progress. */
  "image.pull": {
    params: z.object({ ref: z.string().min(1).max(300) }),
    result: z.object({ ref: z.string(), id: z.string() }),
    stream: PullProgress,
  },
  "image.remove": {
    params: z.object({ ref: z.string().min(1).max(300) }),
    result: z.object({}),
  },
} as const;
