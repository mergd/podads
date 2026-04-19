import type {
  ComplaintRequest,
  EpisodeTranscriptResponse,
  FeedDetailResponse,
  FeedLookupResponse,
  FeedPreviewResponse,
  FeedsListResponse,
  HomeResponse,
  PodcastSearchResponse,
  RegisterFeedResponse
} from "@podads/shared/api";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload ? payload.error : "Request failed";
    throw new Error(message ?? "Request failed");
  }

  return payload as T;
}

export async function fetchHome(): Promise<HomeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/home`);
  return parseJson<HomeResponse>(response);
}

export async function fetchFeeds(query?: string): Promise<FeedsListResponse> {
  const params = query ? `?q=${encodeURIComponent(query)}` : "";
  const response = await fetch(`${API_BASE_URL}/api/feeds${params}`);
  return parseJson<FeedsListResponse>(response);
}

export async function searchPodcasts(query: string): Promise<PodcastSearchResponse> {
  const params = `?q=${encodeURIComponent(query)}`;
  const response = await fetch(`${API_BASE_URL}/api/search/podcasts${params}`);
  return parseJson<PodcastSearchResponse>(response);
}

export async function fetchFeed(slug: string): Promise<FeedDetailResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/${slug}`);
  return parseJson<FeedDetailResponse>(response);
}

export async function fetchEpisodeTranscript(slug: string, episodeId: number): Promise<EpisodeTranscriptResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/${slug}/episodes/${episodeId}/transcript`);
  return parseJson<EpisodeTranscriptResponse>(response);
}

export async function lookupFeed(url: string): Promise<FeedLookupResponse> {
  const params = `?url=${encodeURIComponent(url)}`;
  const response = await fetch(`${API_BASE_URL}/api/feeds/lookup${params}`);
  return parseJson<FeedLookupResponse>(response);
}

export async function previewFeed(url: string): Promise<FeedPreviewResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  return parseJson<FeedPreviewResponse>(response);
}

export async function registerFeed(url: string): Promise<RegisterFeedResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  return parseJson<RegisterFeedResponse>(response);
}

export async function submitComplaint(payload: ComplaintRequest): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  await parseJson<{ ok: boolean }>(response);
}
