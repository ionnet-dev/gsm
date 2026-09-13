/** Thrown by services; converted to a JSON response by the app-level error handler. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Insufficient permissions") =>
  new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const tooManyRequests = (message = "Too many requests") =>
  new HttpError(429, "too_many_requests", message);
