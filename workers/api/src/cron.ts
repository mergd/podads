import { listFeedsForRefresh } from "./lib/feedRegistry";
import { capturePostHogEvent } from "./lib/posthog";
import { refreshFeedWithErrorCapture } from "./lib/feedSync";

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

  await capturePostHogEvent(env, {
    distinctId: "cron:feed-refresh",
    event: "cron_feed_refresh_completed",
    properties: {
      refreshed_count: refreshed,
      failed_count: failed
    }
  });
}
