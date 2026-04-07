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
}

export interface AdSpan {
  startMs: number;
  endMs: number;
  confidence: number;
  reason: string;
}

export interface AdDetectionResult {
  provider: string;
  model: string;
  spans: AdSpan[];
  estimatedCostUsd: number;
}

export interface EpisodeJobMessage {
  type: "episode.process";
  jobId: string;
  feedId: number;
  episodeId: number;
  processingVersion: string;
}

export interface EpisodeRecord {
  id: number;
  feed_id: number;
  title: string | null;
  source_enclosure_url: string;
  source_enclosure_type: string | null;
}
