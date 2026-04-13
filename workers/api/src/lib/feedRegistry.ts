import type {
  EpisodeProcessingDiagnostics,
  EpisodeProcessingPreviewSegment,
  EpisodeProcessingStatus,
  EpisodeProcessingSubstatus,
  EpisodeQueueMessage,
  EpisodeRow,
  EpisodeSummary,
  FeedDetailResponse,
  FeedRow,
  FeedsListResponse,
  FeedSummary,
  HomeResponse,
  RegisterFeedResponse,
  SourceFeed
} from "./types";
import { hashNormalizedUrl, normalizeFeedUrl, slugFromHash } from "./normalizeFeedUrl";

const D1_BATCH_SIZE = 50;

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeProcessingSubstatus(value: unknown): EpisodeProcessingSubstatus | null {
  switch (value) {
    case "queued":
    case "retry_scheduled":
    case "transcribing":
    case "detecting_ads":
    case "rewriting_audio":
    case "finalizing":
      return value;
    default:
      return null;
  }
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeAudioRewriteMode(value: unknown): EpisodeProcessingDiagnostics["audioRewriteMode"] {
  switch (value) {
    case "mp3-frame-splice":
    case "passthrough":
      return value;
    default:
      return null;
  }
}

function parsePreviewSegments(value: unknown): EpisodeProcessingPreviewSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const startMs = parseNumber(candidate.startMs);
    const endMs = parseNumber(candidate.endMs);
    const text = typeof candidate.text === "string" ? candidate.text : null;

    if (startMs === null || endMs === null || text === null) {
      return [];
    }

    return [
      {
        startMs,
        endMs,
        text
      }
    ];
  });
}

function buildEpisodeProcessingDiagnostics(details: Record<string, unknown>): EpisodeProcessingDiagnostics | null {
  const diagnostics: EpisodeProcessingDiagnostics = {
    transcriptSegmentCount: parseNumber(details.transcriptSegmentCount),
    transcriptAnalysisWindowMs: parseNumber(details.transcriptAnalysisWindowMs),
    transcriptAnalyzedDurationMs: parseNumber(details.transcriptAnalyzedDurationMs),
    transcriptAnalysisTruncated: parseBoolean(details.transcriptAnalysisTruncated),
    transcriptOpeningPreview: parsePreviewSegments(details.transcriptOpeningPreview),
    transcriptOpeningSponsorSignals: parseStringArray(details.transcriptOpeningSponsorSignals),
    detectedAdSpanCount: parseNumber(details.adSpanCount),
    openingAdSpanCount: parseNumber(details.openingAdSpanCount),
    adDetectionReasons: parseStringArray(details.adDetectionReasons),
    audioRewriteMode: normalizeAudioRewriteMode(details.audioRewriteMode),
    removedDurationMs: parseNumber(details.removedDurationMs),
    rewriteNotes: parseStringArray(details.rewriteNotes)
  };

  const hasSignal =
    diagnostics.transcriptSegmentCount !== null ||
    diagnostics.transcriptAnalysisWindowMs !== null ||
    diagnostics.transcriptAnalyzedDurationMs !== null ||
    diagnostics.transcriptAnalysisTruncated !== null ||
    diagnostics.transcriptOpeningPreview.length > 0 ||
    diagnostics.transcriptOpeningSponsorSignals.length > 0 ||
    diagnostics.detectedAdSpanCount !== null ||
    diagnostics.openingAdSpanCount !== null ||
    diagnostics.adDetectionReasons.length > 0 ||
    diagnostics.audioRewriteMode !== null ||
    diagnostics.removedDurationMs !== null ||
    diagnostics.rewriteNotes.length > 0;

  return hasSignal ? diagnostics : null;
}

interface FeedRowWithStats extends FeedRow {
  latest_episode_pub_date?: string | null;
  episode_count?: number | string | null;
}

interface EpisodeDateStatRow {
  feed_id: number;
  pub_date: string | null;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** SQL expression: newest-first using stored ms, else episode row creation time. */
const EPISODE_SORT_MS_SQL = "COALESCE(episodes.pub_date_ms, CAST(strftime('%s', episodes.created_at) AS INTEGER) * 1000)";

const EPISODE_SORT_MS_SQL_BARE = "COALESCE(pub_date_ms, CAST(strftime('%s', created_at) AS INTEGER) * 1000)";

function compareNumbersDesc(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return right - left;
}

function sortEpisodeRows(
  rows: Array<EpisodeRow & { feed_slug: string; feed_title: string | null }>
): Array<EpisodeRow & { feed_slug: string; feed_title: string | null }> {
  return [...rows].sort((left, right) => {
    const leftMs = left.pub_date_ms ?? parseDateMs(left.pub_date);
    const rightMs = right.pub_date_ms ?? parseDateMs(right.pub_date);
    const pubDateComparison = compareNumbersDesc(leftMs, rightMs);
    if (pubDateComparison !== 0) {
      return pubDateComparison;
    }

    const processedAtComparison = compareNumbersDesc(
      parseDateMs(left.last_processed_at),
      parseDateMs(right.last_processed_at)
    );
    if (processedAtComparison !== 0) {
      return processedAtComparison;
    }

    const updatedAtComparison = compareNumbersDesc(parseDateMs(left.updated_at), parseDateMs(right.updated_at));
    if (updatedAtComparison !== 0) {
      return updatedAtComparison;
    }

    return right.id - left.id;
  });
}

function sortFeedRows(rows: FeedRowWithStats[]): FeedRowWithStats[] {
  return [...rows].sort((left, right) => {
    const latestEpisodeComparison = compareNumbersDesc(
      parseDateMs(left.latest_episode_pub_date),
      parseDateMs(right.latest_episode_pub_date)
    );
    if (latestEpisodeComparison !== 0) {
      return latestEpisodeComparison;
    }

    const refreshedAtComparison = compareNumbersDesc(parseDateMs(left.last_refreshed_at), parseDateMs(right.last_refreshed_at));
    if (refreshedAtComparison !== 0) {
      return refreshedAtComparison;
    }

    const createdAtComparison = compareNumbersDesc(parseDateMs(left.created_at), parseDateMs(right.created_at));
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return right.id - left.id;
  });
}

function attachFeedEpisodeStats(rows: FeedRow[], episodeStats: EpisodeDateStatRow[]): FeedRowWithStats[] {
  const statsByFeedId = new Map<number, { latestPubDate: string | null; latestPubDateMs: number | null; episodeCount: number }>();

  for (const row of episodeStats) {
    const existing = statsByFeedId.get(row.feed_id) ?? {
      latestPubDate: null,
      latestPubDateMs: null,
      episodeCount: 0
    };
    const nextPubDateMs = parseDateMs(row.pub_date);

    existing.episodeCount += 1;

    if (compareNumbersDesc(nextPubDateMs, existing.latestPubDateMs) < 0) {
      existing.latestPubDate = row.pub_date;
      existing.latestPubDateMs = nextPubDateMs;
    }

    statsByFeedId.set(row.feed_id, existing);
  }

  return rows.map((row) => {
    const stats = statsByFeedId.get(row.id);
    return {
      ...row,
      latest_episode_pub_date: stats?.latestPubDate ?? null,
      episode_count: stats?.episodeCount ?? 0
    };
  });
}

function buildFeedSummary(row: FeedRowWithStats): FeedSummary {
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
    lastRefreshedAt: row.last_refreshed_at,
    latestEpisodePubDate: row.latest_episode_pub_date ?? null,
    episodeCount: Number(row.episode_count ?? 0)
  };
}

function buildEpisodeSummary(
  row: EpisodeRow & { feed_slug: string; feed_title: string | null },
  baseUrl: string,
  uiBaseUrl: string
): EpisodeSummary {
  const processingDetails = parseJsonObject(row.processing_details_json);

  return {
    id: row.id,
    feedId: row.feed_id,
    feedSlug: row.feed_slug,
    feedTitle: row.feed_title ?? "Untitled podcast",
    guid: row.guid,
    title: row.title ?? "Untitled episode",
    description: row.description,
    episodeLink: row.episode_link,
    author: row.author,
    pubDate: row.pub_date,
    duration: row.duration,
    imageUrl: row.image_url,
    sourceEnclosureUrl: row.source_enclosure_url,
    sourceEnclosureType: row.source_enclosure_type,
    sourceEnclosureLength: row.source_enclosure_length,
    cleanedEnclosureUrl: row.cleaned_enclosure_key ? `${baseUrl}/audio/${row.feed_slug}/${row.id}.mp3` : null,
    processingStatus: row.processing_status,
    processingSubstatus: normalizeProcessingSubstatus(processingDetails.processingSubstatus),
    processingDiagnostics: buildEpisodeProcessingDiagnostics(processingDetails),
    lastError: row.last_error,
    reportUrl: `${uiBaseUrl}/report?feed=${encodeURIComponent(row.feed_slug)}&episode=${row.id}`
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function parseEpisodeDurationSeconds(duration: string | null): number | undefined {
  if (!duration) {
    return undefined;
  }

  const trimmed = duration.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
  }

  const parts = trimmed.split(":").map((part) => Number(part));

  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }

  if (parts.length === 2) {
    const minutes = parts[0];
    const seconds = parts[1];

    if (minutes === undefined || seconds === undefined) {
      return undefined;
    }

    return minutes * 60 + seconds;
  }

  const hours = parts[0];
  const minutes = parts[1];
  const seconds = parts[2];

  if (hours === undefined || minutes === undefined || seconds === undefined) {
    return undefined;
  }

  return hours * 3600 + minutes * 60 + seconds;
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

export async function getFeedBySourceUrl(db: D1Database, sourceUrl: string): Promise<FeedRow | null> {
  return getFeedByNormalizedUrl(db, normalizeFeedUrl(sourceUrl));
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
): Promise<void> {
  const now = new Date().toISOString();
  const statements = source.episodes.map((episode) => {
    const pubDateMs = parseDateMs(episode.pubDate);
    return db
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
          pub_date_ms,
          duration,
          source_enclosure_url,
          source_enclosure_type,
          source_enclosure_length,
          processing_status,
          processing_version,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'pending', ?15, ?16)
        ON CONFLICT(feed_id, episode_key) DO UPDATE SET
          guid = excluded.guid,
          title = excluded.title,
          description = excluded.description,
          episode_link = excluded.episode_link,
          author = excluded.author,
          image_url = excluded.image_url,
          pub_date = excluded.pub_date,
          pub_date_ms = excluded.pub_date_ms,
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
        pubDateMs,
        episode.duration,
        episode.sourceEnclosureUrl,
        episode.sourceEnclosureType,
        episode.sourceEnclosureLength,
        processingVersion,
        now
      );
  });

  for (const chunk of chunkArray(statements, D1_BATCH_SIZE)) {
    await db.batch(chunk);
  }
}

export async function markExcessEpisodesSkipped(
  db: D1Database,
  feedId: number,
  keepRecentCount: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'skipped', updated_at = ?3
      WHERE feed_id = ?1
        AND processing_status = 'pending'
        AND id NOT IN (
          SELECT id FROM episodes
          WHERE feed_id = ?1
          ORDER BY ${EPISODE_SORT_MS_SQL_BARE} DESC
          LIMIT ?2
        )`
    )
    .bind(feedId, keepRecentCount, new Date().toISOString())
    .run();
}

export async function selectEpisodesForProcessing(
  db: D1Database,
  feedId: number,
  limit?: number
): Promise<Array<{ id: number; expectedDurationSeconds?: number }>> {
  if (limit !== undefined && limit <= 0) {
    return [];
  }

  const query = limit === undefined
    ? `SELECT episodes.id, episodes.duration
      FROM episodes
      LEFT JOIN jobs AS active_jobs
        ON active_jobs.episode_id = episodes.id
        AND active_jobs.kind = 'episode.process'
        AND active_jobs.status IN ('queued', 'processing')
      WHERE episodes.feed_id = ?1
        AND episodes.processing_status IN ('pending', 'failed')
        AND active_jobs.id IS NULL
      ORDER BY
        CASE episodes.processing_status WHEN 'pending' THEN 0 ELSE 1 END,
        ${EPISODE_SORT_MS_SQL} DESC`
    : `SELECT episodes.id, episodes.duration
      FROM episodes
      LEFT JOIN jobs AS active_jobs
        ON active_jobs.episode_id = episodes.id
        AND active_jobs.kind = 'episode.process'
        AND active_jobs.status IN ('queued', 'processing')
      WHERE episodes.feed_id = ?1
        AND episodes.processing_status IN ('pending', 'failed')
        AND active_jobs.id IS NULL
      ORDER BY
        CASE episodes.processing_status WHEN 'pending' THEN 0 ELSE 1 END,
        ${EPISODE_SORT_MS_SQL} DESC
      LIMIT ?2`;

  const statement = db.prepare(query);
  const rows = limit === undefined
    ? await statement.bind(feedId).all<{ id: number; duration: string | null }>()
    : await statement.bind(feedId, limit).all<{ id: number; duration: string | null }>();

  return rows.results.map((row) => ({
    id: row.id,
    expectedDurationSeconds: parseEpisodeDurationSeconds(row.duration)
  }));
}

export async function selectGlobalPendingEpisodesForProcessing(
  db: D1Database,
  limit: number
): Promise<Array<{ id: number; feedId: number; expectedDurationSeconds?: number }>> {
  if (limit <= 0) {
    return [];
  }

  const rows = await db
    .prepare(
      `SELECT episodes.id, episodes.feed_id, episodes.duration
      FROM episodes
      LEFT JOIN jobs AS active_jobs
        ON active_jobs.episode_id = episodes.id
        AND active_jobs.kind = 'episode.process'
        AND active_jobs.status IN ('queued', 'processing')
      WHERE episodes.processing_status IN ('pending', 'failed')
        AND active_jobs.id IS NULL
      ORDER BY
        CASE episodes.processing_status WHEN 'pending' THEN 0 ELSE 1 END,
        ${EPISODE_SORT_MS_SQL} DESC
      LIMIT ?1`
    )
    .bind(limit)
    .all<{ id: number; feed_id: number; duration: string | null }>();

  return rows.results.map((row) => ({
    id: row.id,
    feedId: row.feed_id,
    expectedDurationSeconds: parseEpisodeDurationSeconds(row.duration)
  }));
}

export async function enqueueEpisodeJobs(
  db: D1Database,
  queue: Queue,
  messages: EpisodeQueueMessage[]
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const statements = messages.flatMap((message) => {
    const queuedDetails = JSON.stringify({
      processingSubstatus: "queued",
      processingSubstatusUpdatedAt: now,
      queuedAt: message.enqueuedAt,
      currentJobId: message.jobId,
      queueAttempt: message.pollAttempt ?? 0
    });

    return [
      db
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
        .bind(message.jobId, message.feedId, message.episodeId, JSON.stringify(message), now),
      db
        .prepare(
          `UPDATE episodes
          SET processing_details_json = ?2, updated_at = ?3
          WHERE id = ?1`
        )
        .bind(message.episodeId, queuedDetails, now)
    ];
  });

  for (const chunk of chunkArray(statements, D1_BATCH_SIZE)) {
    await db.batch(chunk);
  }

  for (const chunk of chunkArray(messages, D1_BATCH_SIZE)) {
    await queue.sendBatch(
      chunk.map((message) => ({
        body: message
      }))
    );
  }
}

export async function getHomeData(db: D1Database, baseUrl: string, uiBaseUrl: string): Promise<HomeResponse> {
  const [latestEpisodes, feeds] = await Promise.all([
    db
      .prepare(
        `SELECT episodes.*, feeds.slug AS feed_slug, feeds.title AS feed_title
        FROM episodes
        INNER JOIN feeds ON feeds.id = episodes.feed_id
        ORDER BY ${EPISODE_SORT_MS_SQL} DESC,
          COALESCE(CAST(strftime('%s', episodes.last_processed_at) AS INTEGER) * 1000, -1) DESC,
          CAST(strftime('%s', episodes.updated_at) AS INTEGER) * 1000 DESC,
          episodes.id DESC
        LIMIT 10`
      )
      .all<EpisodeRow & { feed_slug: string; feed_title: string | null }>(),
    db
      .prepare(
        `WITH ranked_feed_episodes AS (
          SELECT
            feed_id,
            pub_date,
            COUNT(*) OVER (PARTITION BY feed_id) AS episode_count,
            ${EPISODE_SORT_MS_SQL_BARE} AS sort_ms,
            ROW_NUMBER() OVER (
              PARTITION BY feed_id
              ORDER BY ${EPISODE_SORT_MS_SQL_BARE} DESC,
                COALESCE(CAST(strftime('%s', last_processed_at) AS INTEGER) * 1000, -1) DESC,
                CAST(strftime('%s', updated_at) AS INTEGER) * 1000 DESC,
                id DESC
            ) AS row_num
          FROM episodes
        )
        SELECT
          feeds.*,
          ranked_feed_episodes.pub_date AS latest_episode_pub_date,
          COALESCE(ranked_feed_episodes.episode_count, 0) AS episode_count
        FROM feeds
        LEFT JOIN ranked_feed_episodes
          ON ranked_feed_episodes.feed_id = feeds.id
          AND ranked_feed_episodes.row_num = 1
        ORDER BY ranked_feed_episodes.sort_ms DESC,
          COALESCE(CAST(strftime('%s', feeds.last_refreshed_at) AS INTEGER) * 1000, -1) DESC,
          CAST(strftime('%s', feeds.created_at) AS INTEGER) * 1000 DESC,
          feeds.id DESC
        LIMIT 12`
      )
      .all<FeedRowWithStats>()
  ]);

  return {
    latestEpisodes: latestEpisodes.results.map((row) => buildEpisodeSummary(row, baseUrl, uiBaseUrl)),
    feeds: feeds.results.map(buildFeedSummary)
  };
}

export async function listFeeds(db: D1Database, query?: string): Promise<FeedsListResponse> {
  if (query && query.length > 0) {
    const pattern = `%${query}%`;
    const feeds = await db
      .prepare(
        `SELECT *
        FROM feeds
        WHERE title LIKE ?1 OR description LIKE ?1 OR author LIKE ?1`
      )
      .bind(pattern)
      .all<FeedRow>();

    const feedEpisodeStats = await db
      .prepare(
        `SELECT feed_id, pub_date
        FROM episodes`
      )
      .all<EpisodeDateStatRow>();

    const feedsWithStats = attachFeedEpisodeStats(feeds.results, feedEpisodeStats.results);

    const total = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM feeds
        WHERE title LIKE ?1 OR description LIKE ?1 OR author LIKE ?1`
      )
      .bind(pattern)
      .first<{ count: number | string }>();

    return {
      feeds: sortFeedRows(feedsWithStats).slice(0, 100).map(buildFeedSummary),
      total: Number(total?.count ?? feeds.results.length)
    };
  }

  const feeds = await db
    .prepare(
      `SELECT *
      FROM feeds`
    )
    .all<FeedRow>();

  const feedEpisodeStats = await db
    .prepare(
      `SELECT feed_id, pub_date
      FROM episodes`
    )
    .all<EpisodeDateStatRow>();

  const feedsWithStats = attachFeedEpisodeStats(feeds.results, feedEpisodeStats.results);

  const total = await db
    .prepare("SELECT COUNT(*) AS count FROM feeds")
    .first<{ count: number | string }>();

  return {
    feeds: sortFeedRows(feedsWithStats).slice(0, 100).map(buildFeedSummary),
    total: Number(total?.count ?? feeds.results.length)
  };
}

export async function getFeedDetail(db: D1Database, slug: string, baseUrl: string, uiBaseUrl: string): Promise<FeedDetailResponse | null> {
  const feed = await db.prepare("SELECT * FROM feeds WHERE slug = ?1 LIMIT 1").bind(slug).first<FeedRow>();

  if (!feed) {
    return null;
  }

  const episodes = await db
    .prepare(
      `SELECT episodes.*, feeds.slug AS feed_slug, feeds.title AS feed_title
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE feeds.slug = ?1`
    )
    .bind(slug)
    .all<EpisodeRow & { feed_slug: string; feed_title: string | null }>();

  const sortedEpisodes = sortEpisodeRows(episodes.results);
  const feedWithStats: FeedRowWithStats = {
    ...feed,
    latest_episode_pub_date: sortedEpisodes[0]?.pub_date ?? null,
    episode_count: sortedEpisodes.length
  };

  return {
    feed: buildFeedSummary(feedWithStats),
    episodes: sortedEpisodes
      .slice(0, 50)
      .map((row) => buildEpisodeSummary(row, baseUrl, uiBaseUrl)),
    proxiedFeedUrl: `${baseUrl}/feeds/${feedWithStats.slug}.xml`
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

export async function getEpisodeTranscriptMetadata(
  db: D1Database,
  slug: string,
  episodeId: number
): Promise<{ transcriptKey: string; episodeId: number; feedSlug: string } | null> {
  const episode = await db
    .prepare(
      `SELECT episodes.id, episodes.transcript_key, feeds.slug AS feed_slug
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE feeds.slug = ?1 AND episodes.id = ?2
      LIMIT 1`
    )
    .bind(slug, episodeId)
    .first<{ id: number; transcript_key: string | null; feed_slug: string }>();

  if (!episode?.transcript_key) {
    return null;
  }

  return {
    transcriptKey: episode.transcript_key,
    episodeId: episode.id,
    feedSlug: episode.feed_slug
  };
}

export async function getEpisodeById(
  db: D1Database,
  episodeId: number
): Promise<(EpisodeRow & { feed_slug: string }) | null> {
  const row = await db
    .prepare(
      `SELECT episodes.*, feeds.slug AS feed_slug
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE episodes.id = ?1
      LIMIT 1`
    )
    .bind(episodeId)
    .first<EpisodeRow & { feed_slug: string }>();

  return row ?? null;
}

export async function resetEpisodeToPending(db: D1Database, episodeId: number): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'pending', last_error = NULL, updated_at = ?2
      WHERE id = ?1`
    )
    .bind(episodeId, now)
    .run();
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
