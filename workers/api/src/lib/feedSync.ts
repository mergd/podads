import type { EpisodeQueueMessage } from "@podads/shared/queue";

import {
  enqueueEpisodeJobs,
  markExcessEpisodesSkipped,
  markFeedRefreshFailure,
  selectEpisodesForProcessing,
  updateFeedFromSource,
  upsertEpisodes
} from "./feedRegistry";
import { capturePostHogEvent } from "./posthog";
import { parseSourceFeed } from "./rss";
import type { FeedRow, SourceFeed } from "./types";

function getMaxEpisodesOnInitialRefresh(env: Env): number {
  const parsed = Number.parseInt(env.MAX_EPISODES_PER_FEED_REFRESH, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 12;
  }

  return parsed;
}

function getMaxProcessableEpisodesOnInitialRefresh(env: Env): number {
  const parsed = Number.parseInt(env.MAX_PROCESSABLE_EPISODES_PER_FEED, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2;
  }

  return parsed;
}

export async function refreshFeed(env: Env, feed: FeedRow): Promise<number> {
  const isInitialRefresh = feed.last_refreshed_at === null;
  const source = await fetchSourceFeed(feed.source_url);
  await updateFeedFromSource(env.DB, feed.id, source);
  await upsertEpisodes(env.DB, feed.id, source, env.PROCESSING_VERSION);
  if (isInitialRefresh) {
    await markExcessEpisodesSkipped(env.DB, feed.id, getMaxProcessableEpisodesOnInitialRefresh(env));
  }

  const episodesToProcess = await selectEpisodesForProcessing(
    env.DB,
    feed.id,
    isInitialRefresh ? getMaxEpisodesOnInitialRefresh(env) : undefined
  );
  const enqueuedAt = new Date().toISOString();
  const messages: EpisodeQueueMessage[] = episodesToProcess.map((episode) => ({
    type: "episode.process",
    jobId: crypto.randomUUID(),
    feedId: feed.id,
    episodeId: episode.id,
    processingVersion: env.PROCESSING_VERSION,
    enqueuedAt,
    expectedDurationSeconds: episode.expectedDurationSeconds,
    pollAttempt: 0
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

export async function fetchSourceFeed(sourceUrl: string): Promise<SourceFeed> {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "podads-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Feed refresh failed with status ${response.status}`);
  }

  const xml = await response.text();
  return parseSourceFeed(xml);
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
