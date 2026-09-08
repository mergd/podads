import {
  cleanupFile,
  prepareAudioForTranscription
} from "./speedup.js";
import {
  transcribeWithGroq,
  type GroqKeyPool,
  type TranscriptionResult,
  type TranscriptionSegment
} from "./groq.js";

const MIN_SUSPICIOUS_SEGMENT_DURATION_SECONDS = 12;
const FORCE_RETRY_SEGMENT_DURATION_SECONDS = 20;
const MAX_SUSPICIOUS_WORDS_PER_SECOND = 1.6;
const RETRY_CONTEXT_SECONDS = 2;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function wordsPerSecond(segment: TranscriptionSegment): number {
  const duration = segment.end - segment.start;
  return duration > 0 ? wordCount(segment.text) / duration : Number.POSITIVE_INFINITY;
}

/**
 * A very long or long-and-sparse Whisper segment is usually a timestamp-quality
 * issue. We retry at most one such region per episode, so normal slow speech
 * does not trigger a broad re-transcription bill.
 */
export function selectSuspiciousGroqSegment(
  segments: TranscriptionSegment[]
): TranscriptionSegment | undefined {
  return segments
    .filter((segment) =>
      (segment.end - segment.start) >= FORCE_RETRY_SEGMENT_DURATION_SECONDS
      || (
        (segment.end - segment.start) >= MIN_SUSPICIOUS_SEGMENT_DURATION_SECONDS
        && wordsPerSecond(segment) <= MAX_SUSPICIOUS_WORDS_PER_SECOND
      )
    )
    .sort((left, right) => {
      const durationDifference = (right.end - right.start) - (left.end - left.start);
      return durationDifference !== 0 ? durationDifference : wordsPerSecond(left) - wordsPerSecond(right);
    })[0];
}

export function replaceSegmentWithRetry(
  result: TranscriptionResult,
  original: TranscriptionSegment,
  retrySegments: TranscriptionSegment[],
  retryOffsetSeconds: number,
  retryEstimatedCostUsd: number | null
): TranscriptionResult | null {
  const replacements = retrySegments
    .map((segment) => ({
      ...segment,
      start: segment.start + retryOffsetSeconds,
      end: segment.end + retryOffsetSeconds,
      words: segment.words?.map((word) => ({
        ...word,
        start: word.start + retryOffsetSeconds,
        end: word.end + retryOffsetSeconds
      }))
    }))
    .filter((segment) => segment.end > original.start && segment.start < original.end);

  if (replacements.length === 0) {
    return null;
  }

  const segments = [
    ...result.segments.filter((segment) => segment !== original),
    ...replacements
  ]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((segment, id) => ({ ...segment, id }));

  return {
    ...result,
    text: segments.map((segment) => segment.text).join(" ").trim(),
    segments,
    duration: segments.length > 0 ? segments[segments.length - 1]!.end : 0,
    estimatedCostUsd:
      result.estimatedCostUsd === null || retryEstimatedCostUsd === null
        ? null
        : result.estimatedCostUsd + retryEstimatedCostUsd
  };
}

export interface QualityRetryOutcome {
  result: TranscriptionResult;
  attempted: boolean;
  succeeded: boolean;
  error?: string;
}

export async function retrySuspiciousGroqSegment(
  sourceAudioPath: string,
  result: TranscriptionResult,
  keyPool: GroqKeyPool
): Promise<QualityRetryOutcome> {
  const suspiciousSegment = selectSuspiciousGroqSegment(result.segments);
  if (!suspiciousSegment) {
    return { result, attempted: false, succeeded: false };
  }

  const retryStartSeconds = Math.max(0, suspiciousSegment.start - RETRY_CONTEXT_SECONDS);
  const retryDurationSeconds = (suspiciousSegment.end - suspiciousSegment.start) + (RETRY_CONTEXT_SECONDS * 2);
  let retryAudioPath: string | undefined;

  try {
    retryAudioPath = await prepareAudioForTranscription(
      sourceAudioPath,
      1,
      Math.round(retryDurationSeconds * 1000),
      Math.round(retryStartSeconds * 1000)
    );
    const retryResult = await transcribeWithGroq(retryAudioPath, keyPool, 1);
    const replacement = replaceSegmentWithRetry(
      result,
      suspiciousSegment,
      retryResult.segments,
      retryStartSeconds,
      retryResult.estimatedCostUsd
    );

    return replacement
      ? { result: replacement, attempted: true, succeeded: true }
      : { result, attempted: true, succeeded: false, error: "Retry produced no replacement segments." };
  } catch (error) {
    return {
      result,
      attempted: true,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (retryAudioPath) {
      await cleanupFile(retryAudioPath);
    }
  }
}
