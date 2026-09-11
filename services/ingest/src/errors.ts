export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class UpstreamError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(502, message, "dashy_upstream_error", details);
    this.name = "UpstreamError";
  }
}
