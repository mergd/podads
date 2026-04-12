import { gatewayTranscription } from "../providers/transcription/gateway";
import type { EpisodeRecord, TranscriptResult } from "./types";

const MAX_AD_ANALYSIS_DURATION_MS = 2 * 60 * 60 * 1000;

function truncateTranscriptForAnalysis(transcript: TranscriptResult): TranscriptResult {
  const analysisWindowMs = MAX_AD_ANALYSIS_DURATION_MS;
  const analysisTruncated = transcript.segments.some((segment) => segment.endMs > analysisWindowMs);
  const segments = transcript.segments
    .filter((segment) => segment.startMs < analysisWindowMs)
    .map((segment) => ({
      ...segment,
      endMs: Math.min(segment.endMs, analysisWindowMs)
    }))
    .filter((segment) => segment.endMs > segment.startMs);
  const analyzedDurationMs =
    segments.length === 0 ? 0 : segments.reduce((max, segment) => Math.max(max, segment.endMs), 0);

  return {
    ...transcript,
    text: segments.map((segment) => segment.text).join(" ").trim(),
    segments,
    analysisWindowMs,
    analyzedDurationMs,
    analysisTruncated
  };
}

export async function generateTranscript(
  env: Env,
  episode: EpisodeRecord,
  _processingVersion: string,
  _state: Record<string, unknown>
): Promise<TranscriptResult> {
  return truncateTranscriptForAnalysis(await gatewayTranscription(env, episode));
}
