export type TranscriberTier = "basic" | "large";

export const BASIC_TRANSCRIBER_MAX_SOURCE_BYTES = 80 * 1024 * 1024;
export const BASIC_TRANSCRIBER_MAX_DURATION_SECONDS = 90 * 60;

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function selectTranscriberTier(
  sourceBytes: number | null | undefined,
  expectedDurationSeconds: number | null | undefined
): TranscriberTier {
  const bytes = positiveFinite(sourceBytes);
  const durationSeconds = positiveFinite(expectedDurationSeconds);

  if (
    (bytes !== null && bytes > BASIC_TRANSCRIBER_MAX_SOURCE_BYTES)
    || (durationSeconds !== null && durationSeconds > BASIC_TRANSCRIBER_MAX_DURATION_SECONDS)
  ) {
    return "large";
  }

  return bytes !== null || durationSeconds !== null ? "basic" : "large";
}
