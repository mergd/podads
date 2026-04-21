import type { EpisodeQueueMessage } from "@podads/shared/queue";

import { generateBrandedArtwork } from "./artwork";
import {
  enqueueEpisodeJobs,
  markExcessEpisodesSkipped,
  markFeedRefreshComplete,
  markFeedRefreshFailure,
  selectEpisodesForProcessing,
  updateFeedBrandedArtwork,
  updateFeedFromSource,
  upsertEpisodes
} from "./feedRegistry";
import { capturePostHogEvent } from "./posthog";
import { parseSourceFeed } from "./rss";
import type { FeedRow, SourceFeed } from "./types";

function brandedArtworkKey(slug: string): string {
  return `feed-artwork/${slug}.png`;
}

async function syncBrandedArtwork(env: Env, feed: FeedRow, source: SourceFeed): Promise<void> {
  if (!source.imageUrl) {
    return;
  }

  const alreadyBrandedForThisSource =
    feed.branded_image_key !== null && feed.branded_image_source_url === source.imageUrl;
  if (alreadyBrandedForThisSource) {
    return;
  }

  try {
    const { bytes, contentType } = await generateBrandedArtwork(source.imageUrl);
    const key = brandedArtworkKey(feed.slug);
    await env.AUDIO_BUCKET.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=86400" }
    });
    await updateFeedBrandedArtwork(env.DB, feed.id, key, source.imageUrl);
  } catch (error) {
    // Branding is a nice-to-have overlay; never let it fail the refresh.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[artwork] failed to generate branded artwork for ${feed.slug}: ${message}`);
  }
}

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
  await syncBrandedArtwork(env, feed, source);
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

  // Only advance last_refreshed_at after everything succeeds, so a partial run
  // (e.g. scheduled event hitting the CPU budget mid-refresh) is retried next
  // tick instead of being silently marked as "refreshed".
  await markFeedRefreshComplete(env.DB, feed.id);

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
