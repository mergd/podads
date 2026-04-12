export type { EpisodeQueueMessage as EpisodeJobMessage } from "@podads/shared/queue";

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptResult {
  provider: string;
  model: string;
  text: string;
  segments: TranscriptSegment[];
  estimatedCostUsd: number;
  analysisWindowMs: number | null;
  analyzedDurationMs: number;
  analysisTruncated: boolean;
  inputBytes?: number;
  requestDurationMs?: number;
  providerQueueDelayMs?: number;
  providerExecutionMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AdSpan {
  startMs: number;
  endMs: number;
  confidence: number;
  reason: string;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface AdDetectionResult {
  provider: string;
  model: string;
  spans: AdSpan[];
  estimatedCostUsd: number;
  requestDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AudioRewriteManifest {
  mode: "mp3-frame-splice" | "passthrough";
  sourceContentType: string;
  sourceDurationMs: number | null;
  cleanedDurationMs: number | null;
  requestedRemovedRanges: TimeRange[];
  actualRemovedRanges: TimeRange[];
  retainedRanges: TimeRange[];
  frameCount: number | null;
  keptFrameCount: number | null;
  notes: string[];
}

export interface AudioRewriteResult {
  key: string;
  bytesWritten: number;
  manifest: AudioRewriteManifest;
}

export interface EpisodeRecord {
  id: number;
  feed_id: number;
  title: string | null;
  source_enclosure_url: string;
  source_enclosure_type: string | null;
  processing_status: "pending" | "processing" | "ready" | "failed";
  processing_details_json: string;
}
