import type { EpisodeProcessingStatus, FeedStatus } from "@podads/shared/api";

export type {
  ComplaintRequest,
  FeedLookupResponse,
  FeedPreviewEpisode,
  FeedPreviewResponse,
  EpisodeProcessingStatus,
  EpisodeSummary,
  FeedDetailResponse,
  FeedsListResponse,
  FeedStatus,
  FeedSummary,
  HomeResponse,
  RegisterFeedRequest,
  RegisterFeedResponse
} from "@podads/shared/api";
export type { EpisodeQueueMessage } from "@podads/shared/queue";

export interface FeedRow {
  id: number;
  source_url: string;
  normalized_url: string;
  url_hash: string;
  slug: string;
  title: string | null;
  description: string | null;
  site_link: string | null;
  image_url: string | null;
  author: string | null;
  language: string | null;
  categories_json: string;
  metadata_json: string;
  status: FeedStatus;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpisodeRow {
  id: number;
  feed_id: number;
  episode_key: string;
  guid: string | null;
  title: string | null;
  description: string | null;
  episode_link: string | null;
  author: string | null;
  image_url: string | null;
  pub_date: string | null;
  duration: string | null;
  source_enclosure_url: string;
  source_enclosure_type: string | null;
  source_enclosure_length: string | null;
  transcript_key: string | null;
  ad_spans_key: string | null;
  cleaned_enclosure_key: string | null;
  processing_status: EpisodeProcessingStatus;
  processing_version: string | null;
  processing_details_json: string;
  last_processed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceEpisode {
  episodeKey: string;
  guid: string | null;
  title: string | null;
  description: string | null;
  episodeLink: string | null;
  author: string | null;
  imageUrl: string | null;
  pubDate: string | null;
  duration: string | null;
  sourceEnclosureUrl: string;
  sourceEnclosureType: string | null;
  sourceEnclosureLength: string | null;
}

export interface SourceFeed {
  title: string;
  description: string | null;
  siteLink: string | null;
  imageUrl: string | null;
  author: string | null;
  language: string | null;
  categories: string[];
  metadata: Record<string, unknown>;
  episodes: SourceEpisode[];
}
