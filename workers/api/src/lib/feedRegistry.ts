import type {
  EpisodeProcessingStatus,
  EpisodeQueueMessage,
  EpisodeRow,
  EpisodeSummary,
  FeedDetailResponse,
  FeedRow,
  FeedSummary,
  HomeResponse,
  RegisterFeedResponse,
  SourceFeed
} from "./types";
import { hashNormalizedUrl, normalizeFeedUrl, slugFromHash } from "./normalizeFeedUrl";

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function buildFeedSummary(row: FeedRow): FeedSummary {
  return {
    id: row.id,
    slug: row.slug,
    sourceUrl: row.source_url,
    title: row.title ?? "Untitled podcast",
    description: row.description,
    siteLink: row.site_link,
    imageUrl: row.image_url,
    author: row.author,
    language: row.language,
    categories: parseJsonArray(row.categories_json),
    status: row.status,
    lastRefreshedAt: row.last_refreshed_at
  };
}

function buildEpisodeSummary(
  row: EpisodeRow & { feed_slug: string; feed_title: string | null },
  baseUrl: string
): EpisodeSummary {
  return {
    id: row.id,
    feedId: row.feed_id,
    feedSlug: row.feed_slug,
    feedTitle: row.feed_title ?? "Untitled podcast",
    title: row.title ?? "Untitled episode",
    description: row.description,
    pubDate: row.pub_date,
    duration: row.duration,
    imageUrl: row.image_url,
    sourceEnclosureUrl: row.source_enclosure_url,
    cleanedEnclosureUrl: row.cleaned_enclosure_key ? `${baseUrl}/audio/${row.feed_slug}/${row.id}.mp3` : null,
    processingStatus: row.processing_status,
    lastError: row.last_error,
    reportUrl: `${baseUrl}/report?feed=${encodeURIComponent(row.feed_slug)}&episode=${row.id}`
  };
}

export async function getFeedBySlug(db: D1Database, slug: string): Promise<FeedRow | null> {
  const result = await db.prepare("SELECT * FROM feeds WHERE slug = ?1 LIMIT 1").bind(slug).first<FeedRow>();
  return result ?? null;
}

async function getFeedByNormalizedUrl(db: D1Database, normalizedUrl: string): Promise<FeedRow | null> {
  const result = await db
    .prepare("SELECT * FROM feeds WHERE normalized_url = ?1 LIMIT 1")
    .bind(normalizedUrl)
    .first<FeedRow>();

  return result ?? null;
}

async function insertFeed(db: D1Database, sourceUrl: string, normalizedUrl: string): Promise<FeedRow> {
  const hash = await hashNormalizedUrl(normalizedUrl);
  const slug = slugFromHash(hash);

  await db
    .prepare(
      `INSERT INTO feeds (
        source_url,
        normalized_url,
        url_hash,
        slug,
        status
      ) VALUES (?1, ?2, ?3, ?4, 'pending')`
    )
    .bind(sourceUrl, normalizedUrl, hash, slug)
    .run();

  const feed = await getFeedBySlug(db, slug);

  if (!feed) {
    throw new Error("Feed registration failed.");
  }

  return feed;
}

export async function registerFeed(db: D1Database, sourceUrl: string): Promise<{ feed: FeedRow; created: boolean }> {
  const normalizedUrl = normalizeFeedUrl(sourceUrl);
  const existing = await getFeedByNormalizedUrl(db, normalizedUrl);

  if (existing) {
    return { feed: existing, created: false };
  }

  const created = await insertFeed(db, sourceUrl, normalizedUrl);
  return { feed: created, created: true };
}

export async function updateFeedFromSource(db: D1Database, feedId: number, source: SourceFeed): Promise<void> {
  await db
    .prepare(
      `UPDATE feeds
      SET
        title = ?2,
        description = ?3,
        site_link = ?4,
        image_url = ?5,
        author = ?6,
        language = ?7,
        categories_json = ?8,
        metadata_json = ?9,
        status = 'ready',
        last_refreshed_at = ?10,
        last_error = NULL,
        updated_at = ?10
      WHERE id = ?1`
    )
    .bind(
      feedId,
      source.title,
      source.description,
      source.siteLink,
      source.imageUrl,
      source.author,
      source.language,
      JSON.stringify(source.categories),
      JSON.stringify(source.metadata),
      new Date().toISOString()
    )
    .run();
}

export async function markFeedRefreshFailure(db: D1Database, feedId: number, errorMessage: string): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE feeds
      SET status = 'error', last_error = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(feedId, errorMessage, now)
    .run();
}

export async function upsertEpisodes(
  db: D1Database,
  feedId: number,
  source: SourceFeed,
  processingVersion: string
): Promise<number[]> {
  const queuedEpisodeIds: number[] = [];

  for (const episode of source.episodes) {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO episodes (
          feed_id,
          episode_key,
          guid,
          title,
          description,
          episode_link,
          author,
          image_url,
          pub_date,
          duration,
          source_enclosure_url,
          source_enclosure_type,
          source_enclosure_length,
          processing_status,
          processing_version,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending', ?14, ?15)
        ON CONFLICT(feed_id, episode_key) DO UPDATE SET
          guid = excluded.guid,
          title = excluded.title,
          description = excluded.description,
          episode_link = excluded.episode_link,
          author = excluded.author,
          image_url = excluded.image_url,
          pub_date = excluded.pub_date,
          duration = excluded.duration,
          source_enclosure_url = excluded.source_enclosure_url,
          source_enclosure_type = excluded.source_enclosure_type,
          source_enclosure_length = excluded.source_enclosure_length,
          updated_at = excluded.updated_at`
      )
      .bind(
        feedId,
        episode.episodeKey,
        episode.guid,
        episode.title,
        episode.description,
        episode.episodeLink,
        episode.author,
        episode.imageUrl,
        episode.pubDate,
        episode.duration,
        episode.sourceEnclosureUrl,
        episode.sourceEnclosureType,
        episode.sourceEnclosureLength,
        processingVersion,
        now
      )
      .run();

    const row = await db
      .prepare("SELECT id, processing_status, cleaned_enclosure_key FROM episodes WHERE feed_id = ?1 AND episode_key = ?2 LIMIT 1")
      .bind(feedId, episode.episodeKey)
      .first<{ id: number; processing_status: EpisodeProcessingStatus; cleaned_enclosure_key: string | null }>();

    if (!row) {
      continue;
    }

    if (row.processing_status === "pending" || row.processing_status === "failed") {
      queuedEpisodeIds.push(row.id);
    }
  }

  return queuedEpisodeIds;
}

export async function enqueueEpisodeJobs(
  db: D1Database,
  queue: Queue,
  messages: EpisodeQueueMessage[]
): Promise<void> {
  for (const message of messages) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO jobs (
          id,
          kind,
          feed_id,
          episode_id,
          status,
          attempts,
          payload_json,
          updated_at
        ) VALUES (?1, 'episode.process', ?2, ?3, 'queued', 0, ?4, ?5)`
      )
      .bind(message.jobId, message.feedId, message.episodeId, JSON.stringify(message), new Date().toISOString())
      .run();
  }

  await queue.sendBatch(messages.map((message) => ({ body: message })));
}

export async function getHomeData(db: D1Database, baseUrl: string): Promise<HomeResponse> {
  const latestEpisodes = await db
    .prepare(
      `SELECT episodes.*, feeds.slug AS feed_slug, feeds.title AS feed_title
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      ORDER BY COALESCE(episodes.last_processed_at, episodes.pub_date, episodes.updated_at) DESC
      LIMIT 12`
    )
    .all<EpisodeRow & { feed_slug: string; feed_title: string | null }>();

  const feeds = await db
    .prepare(
      `SELECT *
      FROM feeds
      ORDER BY COALESCE(last_refreshed_at, updated_at, created_at) DESC
      LIMIT 12`
    )
    .all<FeedRow>();

  return {
    latestEpisodes: latestEpisodes.results.map((row) => buildEpisodeSummary(row, baseUrl)),
    feeds: feeds.results.map(buildFeedSummary)
  };
}

export async function getFeedDetail(db: D1Database, slug: string, baseUrl: string): Promise<FeedDetailResponse | null> {
  const feed = await getFeedBySlug(db, slug);

  if (!feed) {
    return null;
  }

  const episodes = await db
    .prepare(
      `SELECT episodes.*, feeds.slug AS feed_slug, feeds.title AS feed_title
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE feeds.slug = ?1
      ORDER BY COALESCE(episodes.pub_date, episodes.updated_at) DESC
      LIMIT 50`
    )
    .bind(slug)
    .all<EpisodeRow & { feed_slug: string; feed_title: string | null }>();

  return {
    feed: buildFeedSummary(feed),
    episodes: episodes.results.map((row) => buildEpisodeSummary(row, baseUrl)),
    proxiedFeedUrl: `${baseUrl}/feeds/${feed.slug}.xml`
  };
}

export async function listFeedsForRefresh(db: D1Database): Promise<FeedRow[]> {
  const feeds = await db.prepare("SELECT * FROM feeds ORDER BY created_at ASC").all<FeedRow>();
  return feeds.results;
}

export async function getEpisodeAudioSource(
  db: D1Database,
  slug: string,
  episodeId: number
): Promise<{ cleanedKey: string | null; sourceUrl: string } | null> {
  const episode = await db
    .prepare(
      `SELECT episodes.cleaned_enclosure_key, episodes.source_enclosure_url
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE feeds.slug = ?1 AND episodes.id = ?2
      LIMIT 1`
    )
    .bind(slug, episodeId)
    .first<{ cleaned_enclosure_key: string | null; source_enclosure_url: string }>();

  if (!episode) {
    return null;
  }

  return {
    cleanedKey: episode.cleaned_enclosure_key,
    sourceUrl: episode.source_enclosure_url
  };
}

export async function markEpisodeProcessing(db: D1Database, episodeId: number, processingVersion: string): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'processing', processing_version = ?2, last_error = NULL, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(episodeId, processingVersion, now)
    .run();
}

export function formatRegisterResponse(feed: FeedRow, created: boolean, baseUrl: string): RegisterFeedResponse {
  return {
    created,
    proxiedFeedUrl: `${baseUrl}/feeds/${feed.slug}.xml`,
    feed: buildFeedSummary(feed)
  };
}
