export type FeedStatus = "pending" | "ready" | "error";
export type EpisodeProcessingStatus = "pending" | "processing" | "ready" | "failed";

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
}

export interface EpisodeSummary {
  id: number;
  feedId: number;
  feedSlug: string;
  feedTitle: string;
  title: string;
  description: string | null;
  pubDate: string | null;
  duration: string | null;
  imageUrl: string | null;
  sourceEnclosureUrl: string;
  cleanedEnclosureUrl: string | null;
  processingStatus: EpisodeProcessingStatus;
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

export interface RegisterFeedResponse {
  created: boolean;
  proxiedFeedUrl: string;
  feed: FeedSummary;
}

export interface ComplaintRequest {
  feedSlug?: string;
  episodeId?: number;
  email?: string;
  issueType: "bad_cut" | "missed_ad" | "metadata_issue" | "other";
  message: string;
}
