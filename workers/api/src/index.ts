import { runScheduledRefresh } from "./cron";
import { refreshFeedWithErrorCapture } from "./lib/feedSync";
import {
  formatRegisterResponse,
  getEpisodeAudioSource,
  getFeedBySlug,
  getFeedDetail,
  getHomeData,
  registerFeed
} from "./lib/feedRegistry";
import { capturePostHogEvent } from "./lib/posthog";
import { buildProxiedRssXml } from "./lib/rss";
import type { ComplaintRequest, RegisterFeedRequest } from "./lib/types";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
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
  const detail = await getFeedDetail(env.DB, slug, getBaseUrl(request, env));

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
  const home = await getHomeData(env.DB, getBaseUrl(request, env));
  return json(home);
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
  const detail = await getFeedDetail(env.DB, slug, getBaseUrl(request, env));

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

function parseFeedSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/feeds\/([^/]+)$/);
  return match?.[1] ?? null;
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

    if (request.method === "POST" && url.pathname === "/api/feeds/register") {
      return handleRegisterFeed(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/report") {
      return handleReport(request, env);
    }

    if (request.method === "GET") {
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
