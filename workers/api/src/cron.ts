import type { EpisodeQueueMessage } from "@podads/shared/queue";

import {
  enqueueEpisodeJobs,
  listFeedsForRefresh,
  selectGlobalPendingEpisodesForProcessing
} from "./lib/feedRegistry";
import { capturePostHogEvent } from "./lib/posthog";
import { refreshFeedWithErrorCapture } from "./lib/feedSync";

const PENDING_SWEEP_LIMIT = 50;

async function sweepStrandedPendingEpisodes(env: Env): Promise<number> {
  const episodes = await selectGlobalPendingEpisodesForProcessing(env.DB, PENDING_SWEEP_LIMIT);

  if (episodes.length === 0) {
    return 0;
  }

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

  await enqueueEpisodeJobs(env.DB, env.PROCESSING_QUEUE, messages);
  return messages.length;
}

export async function runScheduledRefresh(env: Env): Promise<void> {
  const feeds = await listFeedsForRefresh(env.DB);
  let refreshed = 0;
  let failed = 0;

  for (const feed of feeds) {
    try {
      await refreshFeedWithErrorCapture(env, feed);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }

  // Safety net: if any episode slipped through as pending with no active job
  // (e.g. a prior refresh was cut short before reaching enqueue), sweep it now.
  let sweptPending = 0;
  try {
    sweptPending = await sweepStrandedPendingEpisodes(env);
  } catch (error) {
    console.warn(
      "[cron] pending episode sweep failed:",
      error instanceof Error ? error.message : error
    );
  }

  await capturePostHogEvent(env, {
    distinctId: "cron:feed-refresh",
    event: "cron_feed_refresh_completed",
    properties: {
      refreshed_count: refreshed,
      failed_count: failed,
      swept_pending_count: sweptPending
    }
  });
}
