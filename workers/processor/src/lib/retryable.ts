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

function clampDelaySeconds(delaySeconds: number): number {
  return Math.max(1, Math.ceil(delaySeconds));
}

function getSeedHash(seed: string | number): number {
  const normalizedSeed = String(seed);
  let hash = 0;

  for (let index = 0; index < normalizedSeed.length; index += 1) {
    hash = ((hash * 31) + normalizedSeed.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
}

function getJitterMultiplier(attempt: number, seed: string | number): number {
  const safeAttempt = Math.max(1, attempt);
  const jitterSeed = Math.sin((safeAttempt * 12.9898) + getSeedHash(seed)) * 43758.5453;
  const normalized = jitterSeed - Math.floor(jitterSeed);

  return 0.85 + (normalized * 0.3);
}

export function getRetryDelaySeconds(
  error: unknown,
  fallbackSeconds: number,
  attempt: number,
  seed: string | number
): number {
  if (!(error instanceof RetryableProcessingError)) {
    return clampDelaySeconds(fallbackSeconds);
  }

  const baseDelaySeconds =
    !error.delaySeconds || !Number.isFinite(error.delaySeconds) || error.delaySeconds <= 0
      ? fallbackSeconds
      : error.delaySeconds;

  const exponentialDelaySeconds = baseDelaySeconds * (2 ** Math.max(0, attempt - 1));
  const jitteredDelaySeconds = exponentialDelaySeconds * getJitterMultiplier(attempt, seed);

  return clampDelaySeconds(jitteredDelaySeconds);
}

export function getNextRetryAttempt(currentAttempt: number | undefined): number {
  return Math.max(1, (currentAttempt ?? 0) + 1);
}

export function stampRetryMessage<T extends { enqueuedAt?: string; pollAttempt?: number }>(message: T): T {
  const nextAttempt = getNextRetryAttempt(message.pollAttempt);
  message.enqueuedAt = new Date().toISOString();
  message.pollAttempt = nextAttempt;

  return message;
}
