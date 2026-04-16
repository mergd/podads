import { MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS } from "@podads/shared/queue";

import { expireOldCleanedAudio } from "./lib/audioRetention";
import { handleEpisodeJob, type EpisodeJobResult } from "./lib/processEpisode";
import { getNextRetryAttempt, getRetryDelaySeconds, stampRetryMessage } from "./lib/retryable";
import { recoverStaleEpisodeJobs } from "./lib/staleJobs";
import type { EpisodeJobMessage } from "./lib/types";

function assertNever(value: never): never {
  throw new Error(`Unhandled queue message type: ${value}`);
}

async function dispatchMessage(env: Env, message: EpisodeJobMessage): Promise<EpisodeJobResult> {
  switch (message.type) {
    case "episode.process":
      return handleEpisodeJob(env, message);
    default:
      assertNever(message.type);
  }
}

async function markUnhandledQueueFailure(env: Env, message: EpisodeJobMessage, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : "Unknown unhandled queue failure";
  const processingAttemptCount = Math.max(1, (message.pollAttempt ?? 0) + 1);
  const processingDetailsJson = JSON.stringify({
    processingSubstatus: null,
    processingSubstatusUpdatedAt: now,
    currentJobId: message.jobId,
    failedAt: now,
    queueAttempt: message.pollAttempt ?? 0,
    processingAttemptCount,
    maxAutomaticProcessingAttempts: MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS,
    unhandledQueueFailure: true
  });

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE jobs
        SET status = 'failed', last_error = ?2, updated_at = ?3
        WHERE id = ?1`
      )
      .bind(message.jobId, errorMessage, now),
    env.DB
      .prepare(
        `UPDATE episodes
        SET processing_status = 'failed', processing_details_json = ?2, last_error = ?3, updated_at = ?4
        WHERE id = ?1`
      )
      .bind(message.episodeId, processingDetailsJson, errorMessage, now)
  ]);
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok", { status: 200 });
  },

  async queue(batch: MessageBatch<EpisodeJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as EpisodeJobMessage;
      try {
        const result = await dispatchMessage(env, body);

        switch (result.kind) {
          case "ack":
            message.ack();
            break;
          case "retry":
            stampRetryMessage(body);
            message.retry({ delaySeconds: result.delaySeconds });
            break;
          default:
            assertNever(result);
        }
      } catch (error) {
        const processingAttemptCount = Math.max(1, (body.pollAttempt ?? 0) + 1);
        if (processingAttemptCount >= MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS) {
          await markUnhandledQueueFailure(env, body, error);
          message.ack();
          continue;
        }

        const nextRetryAttempt = getNextRetryAttempt(body.pollAttempt);
        const delaySeconds = getRetryDelaySeconds(error, 30, nextRetryAttempt, body.episodeId);
        stampRetryMessage(body);
        message.retry({ delaySeconds });
      }
    }
  },

  async scheduled(_event, env): Promise<void> {
    const staleJobRecovery = await recoverStaleEpisodeJobs(env);
    const audioRetention = await expireOldCleanedAudio(env);

    if (staleJobRecovery.recovered > 0) {
      console.log("Recovered stale episode jobs.", staleJobRecovery);
    }

    if (audioRetention.deleted > 0) {
      console.log("Expired old cleaned audio.", audioRetention);
    }
  }
} satisfies ExportedHandler<Env, EpisodeJobMessage>;
