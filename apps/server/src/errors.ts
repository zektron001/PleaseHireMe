export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

/** Raised by a runner when AEGIS G3 aborted the run mid-stream. */
export class PolicyAbortError extends Error {
  constructor() {
    super("Run aborted by policy");
    this.name = "PolicyAbortError";
  }
}
