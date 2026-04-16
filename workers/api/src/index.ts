import type {
  ComplaintRequest,
  EpisodeTranscriptResponse,
  FeedLookupResponse,
  FeedPreviewResponse,
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
  getFeedBySourceUrl,
  getFeedBySlug,
  getFeedDetail,
  getHomeData,
  listFeeds,
  registerFeed,
  resetEpisodeToPending,
  selectGlobalPendingEpisodesForProcessing
} from "./lib/feedRegistry";
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

function getBaseUrl(request: Request, env: Env): string {
  const requestUrl = new URL(request.url);
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") {
    return env.APP_BASE_URL;
  }

  return requestUrl.origin;
}

function getUiBaseUrl(request: Request, env: Env): string {
  const requestUrl = new URL(request.url);
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") {
    return env.PUBLIC_UI_BASE_URL;
  }

  return env.PUBLIC_UI_BASE_URL;
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
  const result = await listFeeds(env.DB, query);
  return json(result);
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

async function handleAudio(request: Request, env: Env, slug: string, episodeId: number): Promise<Response> {
  const audio = await getEpisodeAudioSource(env.DB, slug, episodeId);

  if (!audio) {
    return notFound();
  }

  if (!audio.cleanedKey) {
    return Response.redirect(audio.sourceUrl, 302);
  }

  const object = await env.AUDIO_BUCKET.get(audio.cleanedKey);

  if (!object) {
    return Response.redirect(audio.sourceUrl, 302);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", headers.get("content-type") ?? "audio/mpeg");
  headers.set("cache-control", "public, max-age=300");

  return withCors(
    new Response(object.body, {
      headers
    })
  );
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

  const response: EpisodeTranscriptResponse = {
    episodeId: metadata.episodeId,
    feedSlug: metadata.feedSlug,
    provider: transcript.provider ?? "unknown",
    model: transcript.model ?? "unknown",
    text: transcript.text ?? "",
    analysisTruncated: Boolean(transcript.analysisTruncated),
    analyzedDurationMs: typeof transcript.analyzedDurationMs === "number" ? transcript.analyzedDurationMs : 0,
    segments: Array.isArray(transcript.segments)
      ? transcript.segments.flatMap((segment) => {
          if (
            typeof segment?.startMs !== "number" ||
            typeof segment.endMs !== "number" ||
            typeof segment.text !== "string"
          ) {
            return [];
          }

          return [
            {
              startMs: segment.startMs,
              endMs: segment.endMs,
              text: segment.text
            }
          ];
        })
      : []
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

      const audioRoute = parseAudioRoute(url.pathname);
      if (audioRoute) {
        return handleAudio(request, env, audioRoute.slug, audioRoute.episodeId);
      }
    }

    return notFound();
  },

  async scheduled(_event, env): Promise<void> {
    await runScheduledRefresh(env);
  }
} satisfies ExportedHandler<Env>;
