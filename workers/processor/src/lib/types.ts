import type { AudioRewriteManifest } from "@podads/shared/audio";

export type { AudioRewriteManifest, TimeRange } from "@podads/shared/audio";

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

export interface AdDetectionContext {
  episodeTitle?: string | null;
  feedTitle?: string | null;
  feedSlug?: string | null;
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

export interface AudioRewriteResult {
  key: string;
  bytesWritten: number;
  manifest: AudioRewriteManifest;
}

export interface EpisodeRecord {
  id: number;
  feed_id: number;
  title: string | null;
  feed_title?: string | null;
  feed_slug?: string | null;
  source_enclosure_url: string;
  source_enclosure_type: string | null;
  processing_status: "pending" | "processing" | "ready" | "failed";
  processing_details_json: string;
}
