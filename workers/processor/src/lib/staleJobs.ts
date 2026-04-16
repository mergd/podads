import { MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS } from "@podads/shared/queue";

import type { EpisodeJobMessage } from "./types";

const MIN_STALE_SECONDS = 30 * 60;
const DEFAULT_STALE_SECONDS = 45 * 60;
const MAX_STALE_SECONDS = 3 * 60 * 60;
const STALE_BUFFER_SECONDS = 15 * 60;

interface StaleJobRow {
  attempts: number;
  id: string;
  episode_id: number | null;
  payload_json: string;
  status: "processing" | "queued";
  updated_at: string;
}

function parseMessage(payloadJson: string): EpisodeJobMessage | null {
  try {
    const payload = JSON.parse(payloadJson) as Partial<EpisodeJobMessage>;

    if (
      payload.type !== "episode.process"
      || typeof payload.feedId !== "number"
      || typeof payload.episodeId !== "number"
      || typeof payload.processingVersion !== "string"
    ) {
      return null;
    }

    return {
      type: payload.type,
      jobId: typeof payload.jobId === "string" ? payload.jobId : crypto.randomUUID(),
      feedId: payload.feedId,
      episodeId: payload.episodeId,
      processingVersion: payload.processingVersion,
      enqueuedAt: typeof payload.enqueuedAt === "string" ? payload.enqueuedAt : new Date().toISOString(),
      expectedDurationSeconds: payload.expectedDurationSeconds,
      pollAttempt: payload.pollAttempt
    };
  } catch {
    return null;
  }
}

function getStaleAfterSeconds(message: EpisodeJobMessage): number {
  const expectedDurationSeconds = message.expectedDurationSeconds;

  if (!expectedDurationSeconds || !Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) {
    return DEFAULT_STALE_SECONDS;
  }

  const derivedSeconds = (expectedDurationSeconds * 2) + STALE_BUFFER_SECONDS;
  return Math.max(MIN_STALE_SECONDS, Math.min(MAX_STALE_SECONDS, Math.ceil(derivedSeconds)));
}

function isStale(updatedAt: string, staleAfterSeconds: number): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }

  return (Date.now() - updatedAtMs) >= (staleAfterSeconds * 1000);
}

function getConsumedAttemptCount(row: StaleJobRow, message: EpisodeJobMessage): number {
  return Math.max(
    row.attempts,
    message.pollAttempt ?? 0,
    row.status === "processing" ? 1 : 0
  );
}

export async function recoverStaleEpisodeJobs(env: Env): Promise<{ recovered: number; episodeIds: number[] }> {
  const rows = await env.DB
    .prepare(
      `SELECT id, episode_id, payload_json, updated_at, status, attempts
      FROM jobs
      WHERE kind = 'episode.process'
        AND status IN ('processing', 'queued')`
    )
    .all<StaleJobRow>();

  let recovered = 0;
  const episodeIds: number[] = [];

  for (const row of rows.results) {
    const message = parseMessage(row.payload_json);
    const episodeId = row.episode_id ?? message?.episodeId ?? null;

    if (!message || episodeId === null) {
      continue;
    }

    const staleAfterSeconds = getStaleAfterSeconds(message);

    if (!isStale(row.updated_at, staleAfterSeconds)) {
      continue;
    }

    const now = new Date().toISOString();
    const consumedAttemptCount = getConsumedAttemptCount(row, message);
    const retryLimitReached = consumedAttemptCount >= MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS;
    const retryMessage: EpisodeJobMessage = {
      ...message,
      jobId: crypto.randomUUID(),
      enqueuedAt: now,
      pollAttempt: consumedAttemptCount
    };
    const errorMessage = row.status === "processing"
      ? `Recovered stale processing job after ${staleAfterSeconds}s without completion.`
      : `Recovered stale queued job after ${staleAfterSeconds}s without queue progress.`;
    const queuedDetails = JSON.stringify({
      processingSubstatus: "queued",
      processingSubstatusUpdatedAt: now,
      queuedAt: now,
      currentJobId: retryMessage.jobId,
      queueAttempt: retryMessage.pollAttempt ?? 0,
      recoveryReason: errorMessage,
      recoveredFromJobStatus: row.status,
      processingAttemptCount: consumedAttemptCount + 1,
      maxAutomaticProcessingAttempts: MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS
    });
    const failedDetails = JSON.stringify({
      processingSubstatus: null,
      processingSubstatusUpdatedAt: now,
      currentJobId: message.jobId,
      failedAt: now,
      queueAttempt: message.pollAttempt ?? 0,
      recoveredFromJobStatus: row.status,
      processingAttemptCount: consumedAttemptCount,
      maxAutomaticProcessingAttempts: MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS,
      recoveryReason: errorMessage,
      retryLimitReachedAt: now
    });

    await env.DB.batch(
      retryLimitReached
        ? [
            env.DB
              .prepare(
                `UPDATE jobs
                SET status = 'failed', last_error = ?2, updated_at = ?3
                WHERE id = ?1 AND status = ?4`
              )
              .bind(row.id, errorMessage, now, row.status),
            env.DB
              .prepare(
                `UPDATE episodes
                SET processing_status = 'failed', processing_details_json = ?2, last_error = ?3, updated_at = ?4
                WHERE id = ?1 AND processing_status IN ('processing', 'pending')`
              )
              .bind(episodeId, failedDetails, errorMessage, now)
          ]
        : [
            env.DB
              .prepare(
                `UPDATE jobs
                SET status = 'failed', last_error = ?2, updated_at = ?3
                WHERE id = ?1 AND status = ?4`
              )
              .bind(row.id, errorMessage, now, row.status),
            env.DB
              .prepare(
                `UPDATE episodes
                SET processing_status = 'pending', processing_details_json = ?2, last_error = ?3, updated_at = ?4
                WHERE id = ?1 AND processing_status IN ('processing', 'pending')`
              )
              .bind(episodeId, queuedDetails, errorMessage, now)
          ]
    );

    if (retryLimitReached) {
      continue;
    }

    await env.PROCESSING_QUEUE.sendBatch([
      {
        body: retryMessage
      }
    ]);

    await env.DB
      .prepare(
        `INSERT OR REPLACE INTO jobs (
          id,
          kind,
          feed_id,
          episode_id,
          status,
          attempts,
          payload_json,
          updated_at
        ) VALUES (?1, 'episode.process', ?2, ?3, 'queued', 0, ?4, ?5)`
      )
      .bind(retryMessage.jobId, retryMessage.feedId, retryMessage.episodeId, JSON.stringify(retryMessage), now)
      .run();

    recovered += 1;
    episodeIds.push(retryMessage.episodeId);
  }

  return { recovered, episodeIds };
}
