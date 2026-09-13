import { z } from "zod";

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof Pagination>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Error body returned by every failing API route. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
