export type FeedStatus = "pending" | "ready" | "error";
export type EpisodeProcessingStatus = "pending" | "processing" | "ready" | "failed" | "skipped";
export type EpisodeProcessingSubstatus =
  | "queued"
  | "retry_scheduled"
  | "transcribing"
  | "detecting_ads"
  | "rewriting_audio"
  | "finalizing";

export interface EpisodeProcessingPreviewSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface EpisodeProcessingDiagnostics {
  transcriptSegmentCount: number | null;
  transcriptAnalysisWindowMs: number | null;
  transcriptAnalyzedDurationMs: number | null;
  transcriptAnalysisTruncated: boolean | null;
  transcriptOpeningPreview: EpisodeProcessingPreviewSegment[];
  transcriptOpeningSponsorSignals: string[];
  detectedAdSpanCount: number | null;
  openingAdSpanCount: number | null;
  adDetectionReasons: string[];
  audioRewriteMode: "mp3-frame-splice" | "passthrough" | null;
  removedDurationMs: number | null;
  rewriteNotes: string[];
}

export interface FeedSummary {
  id: number;
  slug: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  siteLink: string | null;
  imageUrl: string | null;
  author: string | null;
  language: string | null;
  categories: string[];
  status: FeedStatus;
  lastRefreshedAt: string | null;
  latestEpisodePubDate: string | null;
  episodeCount: number;
}

export interface EpisodeSummary {
  id: number;
  feedId: number;
  feedSlug: string;
  feedTitle: string;
  guid: string | null;
  title: string;
  description: string | null;
  episodeLink: string | null;
  author: string | null;
  pubDate: string | null;
  duration: string | null;
  imageUrl: string | null;
  sourceEnclosureUrl: string;
  sourceEnclosureType: string | null;
  sourceEnclosureLength: string | null;
  cleanedEnclosureUrl: string | null;
  processingStatus: EpisodeProcessingStatus;
  processingSubstatus: EpisodeProcessingSubstatus | null;
  processingDiagnostics: EpisodeProcessingDiagnostics | null;
  lastError: string | null;
  reportUrl: string;
}

export interface HomeResponse {
  latestEpisodes: EpisodeSummary[];
  feeds: FeedSummary[];
}

export interface FeedDetailResponse {
  feed: FeedSummary;
  episodes: EpisodeSummary[];
  proxiedFeedUrl: string;
}

export interface RegisterFeedRequest {
  url: string;
}

export interface RegisterFeedResponse {
  created: boolean;
  proxiedFeedUrl: string;
  feed: FeedSummary;
}

export interface FeedLookupResponse {
  exists: boolean;
  match: RegisterFeedResponse | null;
}

export interface FeedPreviewEpisode {
  title: string;
  pubDate: string | null;
  duration: string | null;
  imageUrl: string | null;
}

export interface FeedPreviewResponse {
  exists: boolean;
  title: string;
  description: string | null;
  imageUrl: string | null;
  author: string | null;
  episodeCount: number;
  episodes: FeedPreviewEpisode[];
  match: RegisterFeedResponse | null;
}

export interface FeedsListResponse {
  feeds: FeedSummary[];
  total: number;
}

export interface ComplaintRequest {
  feedSlug?: string;
  episodeId?: number;
  email?: string;
  issueType: "bad_cut" | "missed_ad" | "metadata_issue" | "other";
  message: string;
}
