export class RetryableProcessingError extends Error {
  delaySeconds?: number;

  constructor(message: string, delaySeconds?: number) {
    super(message);
    this.name = "RetryableProcessingError";
    this.delaySeconds = delaySeconds;
  }
}

export function isRetryableProcessingError(error: unknown): error is RetryableProcessingError {
  return error instanceof RetryableProcessingError;
}

export function getRetryDelaySeconds(error: unknown, fallbackSeconds: number): number {
  if (!(error instanceof RetryableProcessingError)) {
    return fallbackSeconds;
  }

  if (!error.delaySeconds || !Number.isFinite(error.delaySeconds) || error.delaySeconds <= 0) {
    return fallbackSeconds;
  }

  return Math.max(1, Math.ceil(error.delaySeconds));
}
