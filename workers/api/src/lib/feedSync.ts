import {
  enqueueEpisodeJobs,
  markFeedRefreshFailure,
  updateFeedFromSource,
  upsertEpisodes
} from "./feedRegistry";
import { capturePostHogEvent } from "./posthog";
import { parseSourceFeed } from "./rss";
import type { EpisodeQueueMessage, FeedRow } from "./types";

export async function refreshFeed(env: Env, feed: FeedRow): Promise<number> {
  const response = await fetch(feed.source_url, {
    headers: {
      "user-agent": "podads-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Feed refresh failed with status ${response.status}`);
  }

  const xml = await response.text();
  const source = parseSourceFeed(xml);
  await updateFeedFromSource(env.DB, feed.id, source);

  const episodeIds = await upsertEpisodes(env.DB, feed.id, source, env.PROCESSING_VERSION);
  const messages: EpisodeQueueMessage[] = episodeIds.map((episodeId) => ({
    type: "episode.process",
    jobId: crypto.randomUUID(),
    feedId: feed.id,
    episodeId,
    processingVersion: env.PROCESSING_VERSION
  }));

  if (messages.length > 0) {
    await enqueueEpisodeJobs(env.DB, env.PROCESSING_QUEUE, messages);
  }

  await capturePostHogEvent(env, {
    distinctId: `feed:${feed.slug}`,
    event: "feed_refreshed",
    properties: {
      episode_count: source.episodes.length,
      enqueued_episodes: messages.length,
      feed_slug: feed.slug
    }
  });

  return messages.length;
}

export async function refreshFeedWithErrorCapture(env: Env, feed: FeedRow): Promise<number> {
  try {
    return await refreshFeed(env, feed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown refresh failure";
    await markFeedRefreshFailure(env.DB, feed.id, message);
    await capturePostHogEvent(env, {
      distinctId: `feed:${feed.slug}`,
      event: "feed_refresh_failed",
      properties: {
        feed_slug: feed.slug,
        error: message
      }
    });
    throw error;
  }
}
