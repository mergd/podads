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

function getMaxEpisodesPerRefresh(env: Env): number {
  const parsed = Number.parseInt(env.MAX_EPISODES_PER_FEED_REFRESH, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 12;
  }

  return parsed;
}

function getMaxProcessableEpisodesPerFeed(env: Env): number {
  const parsed = Number.parseInt(env.MAX_PROCESSABLE_EPISODES_PER_FEED, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2;
  }

  return parsed;
}

function getProcessingBatchWindowSeconds(env: Env): number {
  const parsed = Number.parseInt(env.PROCESSING_BATCH_WINDOW_SECONDS, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

export async function refreshFeed(env: Env, feed: FeedRow): Promise<number> {
  const source = await fetchSourceFeed(feed.source_url);
  await updateFeedFromSource(env.DB, feed.id, source);
  await upsertEpisodes(env.DB, feed.id, source, env.PROCESSING_VERSION);
  await markExcessEpisodesSkipped(env.DB, feed.id, getMaxProcessableEpisodesPerFeed(env));

  const episodesToProcess = await selectEpisodesForProcessing(env.DB, feed.id, getMaxEpisodesPerRefresh(env));
  const batchWindowSeconds = getProcessingBatchWindowSeconds(env);
  const enqueuedAt = new Date().toISOString();
  const messages: EpisodeQueueMessage[] = episodesToProcess.map((episode) => ({
    type: "episode.process",
    jobId: crypto.randomUUID(),
    feedId: feed.id,
    episodeId: episode.id,
    processingVersion: env.PROCESSING_VERSION,
    enqueuedAt,
    batchWindowSeconds,
    expectedDurationSeconds: episode.expectedDurationSeconds,
    pollAttempt: 0
  }));

  if (messages.length > 0) {
    await enqueueEpisodeJobs(env.DB, env.PROCESSING_QUEUE, messages, {
      delaySeconds: batchWindowSeconds
    });
  }

  await capturePostHogEvent(env, {
    distinctId: `feed:${feed.slug}`,
    event: "feed_refreshed",
    properties: {
      episode_count: source.episodes.length,
      enqueued_episodes: messages.length,
      processing_batch_window_seconds: batchWindowSeconds,
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
