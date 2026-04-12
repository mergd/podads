import type { EpisodeJobMessage } from "./types";

const MIN_STALE_SECONDS = 30 * 60;
const DEFAULT_STALE_SECONDS = 45 * 60;
const MAX_STALE_SECONDS = 3 * 60 * 60;
const STALE_BUFFER_SECONDS = 15 * 60;

interface StaleJobRow {
  id: string;
  episode_id: number | null;
  payload_json: string;
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
      batchWindowSeconds: payload.batchWindowSeconds,
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

export async function recoverStaleEpisodeJobs(env: Env): Promise<{ recovered: number; episodeIds: number[] }> {
  const rows = await env.DB
    .prepare(
      `SELECT id, episode_id, payload_json, updated_at
      FROM jobs
      WHERE kind = 'episode.process'
        AND status = 'processing'`
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
    const retryMessage: EpisodeJobMessage = {
      ...message,
      jobId: crypto.randomUUID(),
      enqueuedAt: now,
      pollAttempt: (message.pollAttempt ?? 0) + 1
    };
    const errorMessage = `Recovered stale processing job after ${staleAfterSeconds}s without completion.`;

    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE jobs
          SET status = 'failed', last_error = ?2, updated_at = ?3
          WHERE id = ?1 AND status = 'processing'`
        )
        .bind(row.id, errorMessage, now),
      env.DB
        .prepare(
          `UPDATE episodes
          SET processing_status = 'pending', last_error = ?2, updated_at = ?3
          WHERE id = ?1 AND processing_status = 'processing'`
        )
        .bind(episodeId, errorMessage, now)
    ]);

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
