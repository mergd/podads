import type {
  ComplaintRequest,
  EpisodeTranscriptResponse,
  FeedLookupResponse,
  FeedPreviewResponse,
  PodcastSearchItem,
  PodcastSearchResponse,
  RegisterFeedRequest
} from "@podads/shared/api";
import type { EpisodeQueueMessage } from "@podads/shared/queue";

import { runScheduledRefresh } from "./cron";
import { fetchSourceFeed, refreshFeedWithErrorCapture } from "./lib/feedSync";
import {
  enqueueEpisodeJobs,
  formatRegisterResponse,
  getEpisodeAudioSource,
  getEpisodeById,
  getEpisodeTranscriptMetadata,
  getFeedBrandedArtworkKey,
  getFeedBySourceUrl,
  getFeedBySlug,
  getFeedDetail,
  getFeedsByNormalizedUrls,
  getHomeData,
  listFeeds,
  registerFeed,
  resetEpisodeToPending,
  selectGlobalPendingEpisodesForProcessing
} from "./lib/feedRegistry";
import { searchItunesPodcasts } from "./lib/itunesSearch";
import { normalizeFeedUrl } from "./lib/normalizeFeedUrl";
import { capturePostHogEvent } from "./lib/posthog";
import { buildProxiedRssXml } from "./lib/rss";

const PREVIEW_EPISODE_LIMIT = 5;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-admin-secret"
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function json(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    })
  );
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return withCors(
    new Response(body, {
      status,
      headers: {
        "content-type": contentType
      }
    })
  );
}

function notFound(): Response {
  return json({ error: "Not found" }, 404);
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

const DEFAULT_APP_BASE_URL = "https://api.podads.yet-to-be.com";
const DEFAULT_UI_BASE_URL = "https://podads.yet-to-be.com";

function getBaseUrl(request: Request, env: Env): string {
  const override = env.APP_BASE_URL?.trim();
  if (override) {
    return override;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") {
    return requestUrl.origin;
  }

  return DEFAULT_APP_BASE_URL;
}

function getUiBaseUrl(_request: Request, env: Env): string {
  return env.PUBLIC_UI_BASE_URL?.trim() || DEFAULT_UI_BASE_URL;
}

async function handleFeedLookup(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const sourceUrl = requestUrl.searchParams.get("url")?.trim();

  if (!sourceUrl) {
    return badRequest("A podcast RSS URL is required.");
  }

  try {
    const feed = await getFeedBySourceUrl(env.DB, sourceUrl);
    const response: FeedLookupResponse = {
      exists: Boolean(feed),
      match: feed ? formatRegisterResponse(feed, false, getBaseUrl(request, env)) : null
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown feed lookup failure";
    return json({ error: message }, 400);
  }
}

async function handleFeedPreview(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<RegisterFeedRequest>;

  if (!body.url) {
    return badRequest("A podcast RSS URL is required.");
  }

  try {
    const existing = await getFeedBySourceUrl(env.DB, body.url);

    if (existing) {
      const detail = await getFeedDetail(env.DB, existing.slug, getBaseUrl(request, env), getUiBaseUrl(request, env));

      if (!detail) {
        return json({ error: "Feed exists but could not be previewed." }, 500);
      }

      const response: FeedPreviewResponse = {
        exists: true,
        title: detail.feed.title,
        description: detail.feed.description,
        imageUrl: detail.feed.imageUrl,
        author: detail.feed.author,
        episodeCount: detail.episodes.length,
        episodes: detail.episodes.slice(0, PREVIEW_EPISODE_LIMIT).map((episode) => ({
          title: episode.title,
          pubDate: episode.pubDate,
          duration: episode.duration,
          imageUrl: episode.imageUrl
        })),
        match: formatRegisterResponse(existing, false, getBaseUrl(request, env))
      };

      return json(response);
    }

    const source = await fetchSourceFeed(body.url);
    const response: FeedPreviewResponse = {
      exists: false,
      title: source.title,
      description: source.description,
      imageUrl: source.imageUrl,
      author: source.author,
      episodeCount: source.episodes.length,
      episodes: source.episodes.slice(0, PREVIEW_EPISODE_LIMIT).map((episode) => ({
        title: episode.title ?? "Untitled episode",
        pubDate: episode.pubDate,
        duration: episode.duration,
        imageUrl: episode.imageUrl
      })),
      match: null
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown feed preview failure";
    return json({ error: message }, 400);
  }
}

async function handleRegisterFeed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<RegisterFeedRequest>;

  if (!body.url) {
    return badRequest("A podcast RSS URL is required.");
  }

  try {
    const { feed, created } = await registerFeed(env.DB, body.url);
    await refreshFeedWithErrorCapture(env, feed);
    const refreshed = await getFeedBySlug(env.DB, feed.slug);

    if (!refreshed) {
      return json({ error: "Feed registered but could not be reloaded." }, 500);
    }

    await capturePostHogEvent(env, {
      distinctId: `feed:${refreshed.slug}`,
      event: "feed_registered",
      properties: {
        created,
        feed_slug: refreshed.slug,
        normalized_source_url: refreshed.normalized_url
      }
    });

    return json(formatRegisterResponse(refreshed, created, getBaseUrl(request, env)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown registration failure";
    return json({ error: message }, 500);
  }
}

async function handleFeedDetail(request: Request, env: Env, slug: string): Promise<Response> {
  const detail = await getFeedDetail(env.DB, slug, getBaseUrl(request, env), getUiBaseUrl(request, env));

  if (!detail) {
    return notFound();
  }

  await capturePostHogEvent(env, {
    distinctId: `feed:${slug}`,
    event: "feed_viewed",
    properties: {
      feed_slug: slug
    }
  });

  return json(detail);
}

async function handleHome(request: Request, env: Env): Promise<Response> {
  const home = await getHomeData(env.DB, getBaseUrl(request, env), getUiBaseUrl(request, env));
  return json(home);
}

async function handleListFeeds(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() || undefined;
  const result = await listFeeds(env.DB, getBaseUrl(request, env), query);
  return json(result);
}

async function handlePodcastSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const country = url.searchParams.get("country") ?? undefined;

  if (!query) {
    const empty: PodcastSearchResponse = { query: "", results: [] };
    return json(empty);
  }

  try {
    const itunesResults = await searchItunesPodcasts(query, { limit, country });
    const normalizedKeys = itunesResults.map((item) => {
      try {
        return normalizeFeedUrl(item.feedUrl);
      } catch {
        return "";
      }
    });
    const feedsByNormalized = await getFeedsByNormalizedUrls(env.DB, normalizedKeys);

    const results: PodcastSearchItem[] = itunesResults.map((itunes, index) => {
      const key = normalizedKeys[index] ?? "";
      const match = key ? feedsByNormalized.get(key) ?? null : null;
      return {
        itunes,
        feed: match ? formatRegisterResponse(match, false, getBaseUrl(request, env)).feed : null
      };
    });

    const response: PodcastSearchResponse = { query, results };
    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown podcast search failure";
    return json({ error: message }, 502);
  }
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<ComplaintRequest>;

  if (!body.issueType || !body.message) {
    return badRequest("Complaint issue type and message are required.");
  }

  const detail = body.feedSlug ? await getFeedBySlug(env.DB, body.feedSlug) : null;
  await capturePostHogEvent(env, {
    distinctId: `complaint:${body.feedSlug ?? "unknown"}:${body.episodeId ?? "none"}:${crypto.randomUUID()}`,
    event: "complaint_submitted",
    properties: {
      issue_type: body.issueType,
      message: body.message,
      email: body.email ?? null,
      feed_slug: body.feedSlug ?? null,
      episode_id: body.episodeId ?? null,
      feed_title: detail?.title ?? null
    }
  });

  return json({ ok: true });
}

async function handleRss(request: Request, env: Env, slug: string): Promise<Response> {
  const detail = await getFeedDetail(env.DB, slug, getBaseUrl(request, env), getUiBaseUrl(request, env));

  if (!detail) {
    return notFound();
  }

  const rss = buildProxiedRssXml(detail.feed, detail.episodes, detail.proxiedFeedUrl);
  return text(rss, 200, "application/rss+xml; charset=utf-8");
}

function parseRangeHeader(value: string | null, size: number): { offset: number; length: number } | null {
  if (!value) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const startStr = match[1] ?? "";
  const endStr = match[2] ?? "";

  if (startStr === "" && endStr === "") {
    return null;
  }

  if (startStr === "") {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const offset = Number(startStr);
  if (!Number.isFinite(offset) || offset < 0 || offset >= size) {
    return null;
  }

  if (endStr === "") {
    return { offset, length: size - offset };
  }

  const end = Number(endStr);
  if (!Number.isFinite(end) || end < offset) {
    return { offset, length: size - offset };
  }

  const clampedEnd = Math.min(end, size - 1);
  return { offset, length: clampedEnd - offset + 1 };
}

async function handleAudio(request: Request, env: Env, slug: string, episodeId: number): Promise<Response> {
  const audio = await getEpisodeAudioSource(env.DB, slug, episodeId);

  if (!audio) {
    return notFound();
  }

  if (!audio.cleanedKey) {
    return Response.redirect(audio.sourceUrl, 302);
  }

  const isHead = request.method === "HEAD";

  const head = await env.AUDIO_BUCKET.head(audio.cleanedKey);
  if (!head) {
    return Response.redirect(audio.sourceUrl, 302);
  }

  const totalSize = head.size;
  const range = parseRangeHeader(request.headers.get("range"), totalSize);

  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "audio/mpeg");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=300");
  if (head.etag) {
    headers.set("etag", `"${head.etag}"`);
  }

  if (range) {
    const end = range.offset + range.length - 1;
    headers.set("content-range", `bytes ${range.offset}-${end}/${totalSize}`);
    headers.set("content-length", String(range.length));

    if (isHead) {
      return withCors(new Response(null, { status: 206, headers }));
    }

    const ranged = await env.AUDIO_BUCKET.get(audio.cleanedKey, {
      range: { offset: range.offset, length: range.length }
    });

    if (!ranged) {
      return Response.redirect(audio.sourceUrl, 302);
    }

    return withCors(new Response(ranged.body, { status: 206, headers }));
  }

  headers.set("content-length", String(totalSize));

  if (isHead) {
    return withCors(new Response(null, { status: 200, headers }));
  }

  const object = await env.AUDIO_BUCKET.get(audio.cleanedKey);
  if (!object) {
    return Response.redirect(audio.sourceUrl, 302);
  }

  return withCors(new Response(object.body, { status: 200, headers }));
}

interface AdSpanRange {
  startMs: number;
  endMs: number;
}

async function loadAdSpans(env: Env, key: string | null): Promise<AdSpanRange[]> {
  if (!key) {
    return [];
  }

  const object = await env.AUDIO_BUCKET.get(key);
  if (!object) {
    return [];
  }

  const payload = (await object.json()) as { spans?: Array<{ startMs?: number; endMs?: number }> };
  if (!Array.isArray(payload.spans)) {
    return [];
  }

  const spans: AdSpanRange[] = [];
  for (const span of payload.spans) {
    if (typeof span?.startMs === "number" && typeof span.endMs === "number" && span.endMs > span.startMs) {
      spans.push({ startMs: span.startMs, endMs: span.endMs });
    }
  }

  return spans.sort((left, right) => left.startMs - right.startMs);
}

function removedMsBefore(spans: AdSpanRange[], timeMs: number): number {
  let removed = 0;
  for (const span of spans) {
    if (span.endMs <= timeMs) {
      removed += span.endMs - span.startMs;
    } else if (span.startMs < timeMs) {
      removed += timeMs - span.startMs;
    } else {
      break;
    }
  }
  return removed;
}

function isInsideAdSpan(spans: AdSpanRange[], startMs: number, endMs: number): boolean {
  const midpoint = (startMs + endMs) / 2;
  for (const span of spans) {
    if (midpoint >= span.startMs && midpoint < span.endMs) {
      return true;
    }
  }
  return false;
}

async function handleEpisodeTranscript(env: Env, slug: string, episodeId: number): Promise<Response> {
  const metadata = await getEpisodeTranscriptMetadata(env.DB, slug, episodeId);

  if (!metadata) {
    return notFound();
  }

  const object = await env.AUDIO_BUCKET.get(metadata.transcriptKey);

  if (!object) {
    return notFound();
  }

  const transcript = (await object.json()) as {
    provider?: string;
    model?: string;
    text?: string;
    analysisTruncated?: boolean;
    analyzedDurationMs?: number;
    segments?: Array<{ startMs?: number; endMs?: number; text?: string }>;
  };

  const adSpans = await loadAdSpans(env, metadata.adSpansKey);
  const totalRemovedMs = adSpans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0);

  const rawSegments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const cleanedSegments: EpisodeTranscriptResponse["segments"] = [];
  const cleanedTextParts: string[] = [];

  for (const segment of rawSegments) {
    if (
      typeof segment?.startMs !== "number" ||
      typeof segment.endMs !== "number" ||
      typeof segment.text !== "string"
    ) {
      continue;
    }

    if (isInsideAdSpan(adSpans, segment.startMs, segment.endMs)) {
      continue;
    }

    const shiftStart = removedMsBefore(adSpans, segment.startMs);
    const shiftEnd = removedMsBefore(adSpans, segment.endMs);
    cleanedSegments.push({
      startMs: Math.max(0, segment.startMs - shiftStart),
      endMs: Math.max(0, segment.endMs - shiftEnd),
      text: segment.text
    });
    cleanedTextParts.push(segment.text);
  }

  const rawAnalyzedDurationMs =
    typeof transcript.analyzedDurationMs === "number" ? transcript.analyzedDurationMs : 0;
  const analyzedDurationMs = Math.max(0, rawAnalyzedDurationMs - totalRemovedMs);

  const response: EpisodeTranscriptResponse = {
    episodeId: metadata.episodeId,
    feedSlug: metadata.feedSlug,
    provider: transcript.provider ?? "unknown",
    model: transcript.model ?? "unknown",
    text: adSpans.length > 0 ? cleanedTextParts.join(" ").trim() : transcript.text ?? "",
    analysisTruncated: Boolean(transcript.analysisTruncated),
    analyzedDurationMs,
    segments: cleanedSegments
  };

  return json(response);
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401);
}

function verifyAdminSecret(request: Request, env: Env): boolean {
  const header = request.headers.get("x-admin-secret");
  return Boolean(env.ADMIN_SECRET) && header === env.ADMIN_SECRET;
}

function countRowsToObject(rows: Array<{ count: number | string; status: string }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function handleAdminStatus(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminSecret(request, env)) {
    return unauthorized();
  }

  const [episodeCounts, jobCounts, queuedSummary, feedSummary] = await Promise.all([
    env.DB
      .prepare(
        `SELECT processing_status AS status, COUNT(*) AS count
        FROM episodes
        GROUP BY processing_status`
      )
      .all<{ status: string; count: number | string }>(),
    env.DB
      .prepare(
        `SELECT status, COUNT(*) AS count
        FROM jobs
        GROUP BY status`
      )
      .all<{ status: string; count: number | string }>(),
    env.DB
      .prepare(
        `SELECT
          COUNT(*) AS queued_count,
          MIN(updated_at) AS oldest_updated_at,
          MAX(updated_at) AS newest_updated_at,
          SUM(
            CASE
              WHEN CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER) >= 2700
              THEN 1
              ELSE 0
            END
          ) AS stale_count
        FROM jobs
        WHERE status = 'queued'`
      )
      .first<{
        queued_count: number | string;
        oldest_updated_at: string | null;
        newest_updated_at: string | null;
        stale_count: number | string | null;
      }>(),
    env.DB
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
          MAX(last_refreshed_at) AS last_refreshed_at
        FROM feeds`
      )
      .first<{
        error_count: number | string | null;
        last_refreshed_at: string | null;
      }>()
  ]);

  const oldestQueuedUpdatedAt = queuedSummary?.oldest_updated_at ?? null;
  const oldestQueuedAgeMinutes = oldestQueuedUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(oldestQueuedUpdatedAt)) / 60000))
    : null;

  return json({
    generatedAt: new Date().toISOString(),
    episodes: countRowsToObject(episodeCounts.results),
    jobs: {
      counts: countRowsToObject(jobCounts.results),
      queued: {
        count: Number(queuedSummary?.queued_count ?? 0),
        staleCount: Number(queuedSummary?.stale_count ?? 0),
        oldestUpdatedAt: oldestQueuedUpdatedAt,
        oldestAgeMinutes: oldestQueuedAgeMinutes,
        newestUpdatedAt: queuedSummary?.newest_updated_at ?? null
      }
    },
    feeds: {
      errorCount: Number(feedSummary?.error_count ?? 0),
      lastRefreshedAt: feedSummary?.last_refreshed_at ?? null
    }
  });
}

async function handleAdminProcessPendingEpisodes(request: Request, env: Env): Promise<Response> {
  if (!verifyAdminSecret(request, env)) {
    return unauthorized();
  }

  const requestUrl = new URL(request.url);
  const rawLimit = requestUrl.searchParams.get("limit");
  const parsed = rawLimit ? Number.parseInt(rawLimit, 10) : 500;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(2000, parsed) : 500;

  const episodes = await selectGlobalPendingEpisodesForProcessing(env.DB, limit);
  const enqueuedAt = new Date().toISOString();
  const messages: EpisodeQueueMessage[] = episodes.map((episode) => ({
    type: "episode.process",
    jobId: crypto.randomUUID(),
    feedId: episode.feedId,
    episodeId: episode.id,
    processingVersion: env.PROCESSING_VERSION,
    enqueuedAt,
    expectedDurationSeconds: episode.expectedDurationSeconds,
    pollAttempt: 0
  }));

  if (messages.length > 0) {
    await enqueueEpisodeJobs(env.DB, env.PROCESSING_QUEUE, messages);
  }

  return json({
    ok: true,
    enqueued: messages.length,
    limit,
    episodeIds: messages.map((m) => m.episodeId)
  });
}

async function handleAdminProcessEpisode(request: Request, env: Env, episodeId: number): Promise<Response> {
  if (!verifyAdminSecret(request, env)) {
    return unauthorized();
  }

  const episode = await getEpisodeById(env.DB, episodeId);

  if (!episode) {
    return notFound();
  }

  await resetEpisodeToPending(env.DB, episodeId);

  const enqueuedAt = new Date().toISOString();
  const message: EpisodeQueueMessage = {
    type: "episode.process",
    jobId: crypto.randomUUID(),
    feedId: episode.feed_id,
    episodeId: episode.id,
    processingVersion: env.PROCESSING_VERSION,
    enqueuedAt,
    pollAttempt: 0
  };

  await enqueueEpisodeJobs(env.DB, env.PROCESSING_QUEUE, [message]);

  return json({ ok: true, episodeId: episode.id, feedSlug: episode.feed_slug });
}

function parseAdminProcessEpisodeRoute(pathname: string): number | null {
  const match = pathname.match(/^\/api\/admin\/episodes\/(\d+)\/process$/);
  return match?.[1] ? Number(match[1]) : null;
}

function parseFeedSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/feeds\/([^/]+)$/);
  return match?.[1] ?? null;
}

function parseTranscriptRoute(pathname: string): { slug: string; episodeId: number } | null {
  const match = pathname.match(/^\/api\/feeds\/([^/]+)\/episodes\/(\d+)\/transcript$/);

  if (!match) {
    return null;
  }

  return {
    slug: match[1] ?? "",
    episodeId: Number(match[2] ?? "0")
  };
}

function parseRssSlug(pathname: string): string | null {
  const match = pathname.match(/^\/feeds\/([^/]+)\.xml$/);
  return match?.[1] ?? null;
}

function parseFeedArtworkSlug(pathname: string): string | null {
  const match = pathname.match(/^\/feed-artwork\/([^/]+)\.png$/);
  return match?.[1] ?? null;
}

async function handleFeedArtwork(request: Request, env: Env, slug: string): Promise<Response> {
  const key = await getFeedBrandedArtworkKey(env.DB, slug);
  if (!key) {
    return notFound();
  }

  const isHead = request.method === "HEAD";
  const object = isHead ? await env.AUDIO_BUCKET.head(key) : await env.AUDIO_BUCKET.get(key);
  if (!object) {
    return notFound();
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "image/png");
  headers.set("cache-control", "public, max-age=86400");
  if (object.etag) {
    headers.set("etag", `"${object.etag}"`);
  }

  if (isHead) {
    return withCors(new Response(null, { status: 200, headers }));
  }

  return withCors(new Response((object as R2ObjectBody).body, { status: 200, headers }));
}

function parseAudioRoute(pathname: string): { slug: string; episodeId: number } | null {
  const match = pathname.match(/^\/audio\/([^/]+)\/(\d+)\.mp3$/);

  if (!match) {
    return null;
  }

  return {
    slug: match[1] ?? "",
    episodeId: Number(match[2] ?? "0")
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (request.method === "GET" && url.pathname === "/api/home") {
      return handleHome(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/feeds") {
      return handleListFeeds(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/feeds/lookup") {
      return handleFeedLookup(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/search/podcasts") {
      return handlePodcastSearch(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/admin/status") {
      return handleAdminStatus(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/feeds/preview") {
      return handleFeedPreview(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/feeds/register") {
      return handleRegisterFeed(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/report") {
      return handleReport(request, env);
    }

    if (request.method === "POST") {
      if (url.pathname === "/api/admin/episodes/process-pending") {
        return handleAdminProcessPendingEpisodes(request, env);
      }

      const adminEpisodeId = parseAdminProcessEpisodeRoute(url.pathname);
      if (adminEpisodeId !== null) {
        return handleAdminProcessEpisode(request, env, adminEpisodeId);
      }
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const audioRouteEarly = parseAudioRoute(url.pathname);
      if (audioRouteEarly) {
        return handleAudio(request, env, audioRouteEarly.slug, audioRouteEarly.episodeId);
      }

      const artworkSlug = parseFeedArtworkSlug(url.pathname);
      if (artworkSlug) {
        return handleFeedArtwork(request, env, artworkSlug);
      }
    }

    if (request.method === "GET") {
      const transcriptRoute = parseTranscriptRoute(url.pathname);
      if (transcriptRoute) {
        return handleEpisodeTranscript(env, transcriptRoute.slug, transcriptRoute.episodeId);
      }

      const feedSlug = parseFeedSlug(url.pathname);
      if (feedSlug) {
        return handleFeedDetail(request, env, feedSlug);
      }

      const rssSlug = parseRssSlug(url.pathname);
      if (rssSlug) {
        return handleRss(request, env, rssSlug);
      }

    }

    return notFound();
  },

  async scheduled(_event, env): Promise<void> {
    await runScheduledRefresh(env);
  }
} satisfies ExportedHandler<Env>;
