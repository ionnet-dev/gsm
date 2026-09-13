/** Thin fetch wrapper: same-origin cookies, CSRF header, uniform error shape. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = "/api/v1";

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown; query?: Record<string, unknown> } = {},
): Promise<T> {
  const { json, query, headers, ...rest } = init;
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const res = await fetch(url, {
    ...rest,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "x-gsm-client": "web",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      window.dispatchEvent(new CustomEvent("gsm:unauthorized"));
    }
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return body as T;
}

/** An error for a toast: validation failures name the first offending field. */
export function errorMessage(e: Error): string {
  if (!(e instanceof ApiError) || !Array.isArray(e.details) || !e.details.length) return e.message;
  const first = e.details[0] as { path?: (string | number)[]; message?: string };
  const where = first.path?.length ? `${first.path.join(".")}: ` : "";
  return first.message ? `${where}${first.message}` : e.message;
}

export const get = <T>(path: string, query?: Record<string, unknown>) =>
  api<T>(path, { method: "GET", query });
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: "POST", json });
export const patch = <T>(path: string, json?: unknown) => api<T>(path, { method: "PATCH", json });
export const put = <T>(path: string, json?: unknown) => api<T>(path, { method: "PUT", json });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
