import type { ItunesPodcastResult } from "@podads/shared/api";

const ITUNES_SEARCH_ENDPOINT = "https://itunes.apple.com/search";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

interface RawItunesResult {
  collectionId?: number;
  collectionName?: string;
  trackName?: string;
  artistName?: string;
  feedUrl?: string;
  collectionViewUrl?: string;
  artworkUrl600?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  genres?: string[];
  trackCount?: number;
  country?: string;
  releaseDate?: string;
}

function mapResult(raw: RawItunesResult): ItunesPodcastResult | null {
  if (typeof raw.collectionId !== "number" || typeof raw.feedUrl !== "string" || raw.feedUrl.length === 0) {
    return null;
  }

  return {
    collectionId: raw.collectionId,
    title: raw.collectionName ?? raw.trackName ?? "Untitled podcast",
    author: raw.artistName ?? null,
    feedUrl: raw.feedUrl,
    collectionViewUrl: raw.collectionViewUrl ?? null,
    artworkUrl: raw.artworkUrl600 ?? raw.artworkUrl100 ?? raw.artworkUrl60 ?? null,
    genres: Array.isArray(raw.genres) ? raw.genres.filter((g): g is string => typeof g === "string") : [],
    trackCount: typeof raw.trackCount === "number" ? raw.trackCount : null,
    country: raw.country ?? null,
    releaseDate: raw.releaseDate ?? null
  };
}

export interface ItunesSearchOptions {
  limit?: number;
  country?: string;
}

export async function searchItunesPodcasts(
  query: string,
  options: ItunesSearchOptions = {}
): Promise<ItunesPodcastResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const country = options.country?.trim() || "US";

  const params = new URLSearchParams({
    media: "podcast",
    entity: "podcast",
    term: trimmed,
    limit: String(limit),
    country
  });

  const response = await fetch(`${ITUNES_SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });

  if (!response.ok) {
    throw new Error(`iTunes search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { results?: RawItunesResult[] };
  const results = Array.isArray(payload.results) ? payload.results : [];

  const mapped: ItunesPodcastResult[] = [];
  const seen = new Set<number>();
  for (const raw of results) {
    const item = mapResult(raw);
    if (!item) continue;
    if (seen.has(item.collectionId)) continue;
    seen.add(item.collectionId);
    mapped.push(item);
  }

  return mapped;
}
