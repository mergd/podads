const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * A temporary failure while communicating with an audio source or STT provider.
 * These need to reach the processor as a 503 so the episode can be retried.
 */
export class UpstreamTransportError extends Error {
  readonly retryAfterSeconds: number;

  constructor(upstream: string, cause: unknown, retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${upstream} transport error: ${detail}`);
    this.name = "UpstreamTransportError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
