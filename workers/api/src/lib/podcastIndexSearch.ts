import type { ItunesPodcastResult } from "@podads/shared/api";

const PODCAST_INDEX_SEARCH_ENDPOINT = "https://api.podcastindex.org/api/1.0/search/byterm";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

interface RawPodcastIndexFeed {
  id?: number;
  title?: string;
  url?: string;
  link?: string;
  author?: string;
  image?: string;
  artwork?: string;
  itunesId?: number;
  categories?: Record<string, string>;
  episodeCount?: number;
  newestItemPubdate?: number;
  dead?: number;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAuthorization(apiKey: string, apiSecret: string, timestamp: string): Promise<string> {
  const input = new TextEncoder().encode(`${apiKey}${apiSecret}${timestamp}`);
  return toHex(await crypto.subtle.digest("SHA-1", input));
}

function mapResult(raw: RawPodcastIndexFeed): ItunesPodcastResult | null {
  if (typeof raw.id !== "number" || typeof raw.url !== "string" || !raw.url || raw.dead === 1) {
    return null;
  }

  const newestItemDate =
    typeof raw.newestItemPubdate === "number" && raw.newestItemPubdate > 0
      ? new Date(raw.newestItemPubdate * 1000).toISOString()
      : null;

  return {
    collectionId: raw.id,
    title: raw.title?.trim() || "Untitled podcast",
    author: raw.author?.trim() || null,
    feedUrl: raw.url,
    collectionViewUrl: raw.link?.trim() || null,
    artworkUrl: raw.image?.trim() || raw.artwork?.trim() || null,
    genres: raw.categories ? Object.values(raw.categories) : [],
    trackCount: typeof raw.episodeCount === "number" ? raw.episodeCount : null,
    country: null,
    releaseDate: newestItemDate
  };
}

export interface PodcastIndexSearchOptions {
  limit?: number;
}

export async function searchPodcastIndex(
  query: string,
  env: Pick<Env, "PODCAST_INDEX_API_KEY" | "PODCAST_INDEX_API_SECRET">,
  options: PodcastIndexSearchOptions = {}
): Promise<ItunesPodcastResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const apiKey = env.PODCAST_INDEX_API_KEY?.trim();
  const apiSecret = env.PODCAST_INDEX_API_SECRET?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error("Podcast Index credentials are not configured");
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authorization = await createAuthorization(apiKey, apiSecret, timestamp);
  const params = new URLSearchParams({ q: trimmed, max: String(limit) });
  params.append("similar", "");

  const response = await fetch(`${PODCAST_INDEX_SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: {
      accept: "application/json",
      authorization,
      "user-agent": "PodAds/1.0",
      "x-auth-date": timestamp,
      "x-auth-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Podcast Index search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { feeds?: RawPodcastIndexFeed[] };
  const feeds = Array.isArray(payload.feeds) ? payload.feeds : [];
  const mapped: ItunesPodcastResult[] = [];
  const seen = new Set<number>();

  for (const raw of feeds) {
    const item = mapResult(raw);
    if (!item || seen.has(item.collectionId)) continue;
    seen.add(item.collectionId);
    mapped.push(item);
  }

  return mapped;
}
