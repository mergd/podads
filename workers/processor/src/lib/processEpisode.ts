import { detectAdSpans } from "./adDetection";
import { rewriteAudio } from "./audioRewrite";
import { capturePostHogEvent } from "./posthog";
import { getRetryDelaySeconds, isRetryableProcessingError } from "./retryable";
import { generateTranscript } from "./transcription";
import type { EpisodeJobMessage, EpisodeRecord } from "./types";

async function loadEpisode(db: D1Database, episodeId: number): Promise<EpisodeRecord | null> {
  const episode = await db
    .prepare(
      `SELECT id, feed_id, title, source_enclosure_url, source_enclosure_type, processing_status, processing_details_json
      FROM episodes
      WHERE id = ?1
      LIMIT 1`
    )
    .bind(episodeId)
    .first<EpisodeRecord>();

  return episode ?? null;
}

async function markJobProcessing(db: D1Database, message: EpisodeJobMessage): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE jobs
      SET status = 'processing', attempts = attempts + 1, updated_at = ?2
      WHERE id = ?1`
    )
    .bind(message.jobId, now)
    .run();

  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'processing', processing_version = ?2, last_error = NULL, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.episodeId, message.processingVersion, now)
    .run();
}

async function markJobFailed(db: D1Database, message: EpisodeJobMessage, errorMessage: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE jobs
      SET status = 'failed', last_error = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.jobId, errorMessage, now)
    .run();

  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'failed', last_error = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.episodeId, errorMessage, now)
    .run();
}

async function markJobQueuedForRetry(
  db: D1Database,
  message: EpisodeJobMessage,
  errorMessage: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE jobs
      SET status = 'queued', last_error = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.jobId, errorMessage, now)
    .run();

  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'pending', last_error = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.episodeId, errorMessage, now)
    .run();
}

async function markJobComplete(
  db: D1Database,
  message: EpisodeJobMessage,
  cleanedEnclosureKey: string,
  transcriptKey: string,
  adSpansKey: string,
  processingDetailsJson: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE jobs
      SET status = 'complete', last_error = NULL, updated_at = ?2
      WHERE id = ?1`
    )
    .bind(message.jobId, now)
    .run();

  await db
    .prepare(
      `UPDATE episodes
      SET
        processing_status = 'ready',
        cleaned_enclosure_key = ?2,
        transcript_key = ?3,
        ad_spans_key = ?4,
        processing_details_json = ?5,
        last_processed_at = ?6,
        updated_at = ?6
      WHERE id = ?1`
    )
    .bind(message.episodeId, cleanedEnclosureKey, transcriptKey, adSpansKey, processingDetailsJson, now)
    .run();
}

async function putJsonArtifact(
  bucket: R2Bucket,
  key: string,
  value: unknown,
  customMetadata?: Record<string, string>
): Promise<void> {
  await bucket.put(key, JSON.stringify(value, null, 2), {
    httpMetadata: {
      contentType: "application/json"
    },
    customMetadata
  });
}

export async function processEpisodeJob(env: Env, message: EpisodeJobMessage): Promise<void> {
  const startedAt = Date.now();
  const episode = await loadEpisode(env.DB, message.episodeId);

  if (!episode) {
    throw new Error(`Episode ${message.episodeId} could not be loaded.`);
  }

  await markJobProcessing(env.DB, message);

  const distinctId = `episode:${episode.id}`;
  const queueDelayMs = Date.now() - Date.parse(message.enqueuedAt);
  const transcript = await generateTranscript(env, episode, message.processingVersion, {});
  await capturePostHogEvent(env, distinctId, "transcript_completed", {
    provider: transcript.provider,
    model: transcript.model,
    estimated_cost_usd: transcript.estimatedCostUsd,
    segment_count: transcript.segments.length,
    input_bytes: transcript.inputBytes,
    request_duration_ms: transcript.requestDurationMs,
    provider_queue_delay_ms: transcript.providerQueueDelayMs,
    provider_execution_ms: transcript.providerExecutionMs,
    prompt_tokens: transcript.promptTokens,
    completion_tokens: transcript.completionTokens,
    total_tokens: transcript.totalTokens,
    queue_delay_ms: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
    episode_id: episode.id,
    feed_id: episode.feed_id
  });

  const detection = await detectAdSpans(env, transcript);
  await capturePostHogEvent(env, distinctId, "ad_detection_completed", {
    provider: detection.provider,
    model: detection.model,
    estimated_cost_usd: detection.estimatedCostUsd,
    ad_span_count: detection.spans.length,
    request_duration_ms: detection.requestDurationMs,
    prompt_tokens: detection.promptTokens,
    completion_tokens: detection.completionTokens,
    total_tokens: detection.totalTokens,
    episode_id: episode.id,
    feed_id: episode.feed_id
  });

  const transcriptKey = `transcripts/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;
  const adSpansKey = `ad-spans/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;
  const splicePlanKey = `splice-plans/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;

  await putJsonArtifact(env.AUDIO_BUCKET, transcriptKey, transcript, {
    episodeId: String(episode.id),
    feedId: String(episode.feed_id)
  });
  await putJsonArtifact(env.AUDIO_BUCKET, adSpansKey, detection, {
    episodeId: String(episode.id),
    feedId: String(episode.feed_id)
  });

  const audioOutput = await rewriteAudio(
    env,
    episode.source_enclosure_url,
    episode.source_enclosure_type,
    episode.feed_id,
    episode.id,
    message.processingVersion,
    detection.spans
  );
  await putJsonArtifact(env.AUDIO_BUCKET, splicePlanKey, audioOutput.manifest, {
    episodeId: String(episode.id),
    feedId: String(episode.feed_id)
  });

  const totalEstimatedCost = transcript.estimatedCostUsd + detection.estimatedCostUsd;
  const removedDurationMs =
    audioOutput.manifest.sourceDurationMs !== null && audioOutput.manifest.cleanedDurationMs !== null
      ? audioOutput.manifest.sourceDurationMs - audioOutput.manifest.cleanedDurationMs
      : null;
  const processingDetails = {
    transcriptProvider: transcript.provider,
    transcriptModel: transcript.model,
    transcriptAnalysisWindowMs: transcript.analysisWindowMs,
    transcriptAnalyzedDurationMs: transcript.analyzedDurationMs,
    transcriptAnalysisTruncated: transcript.analysisTruncated,
    transcriptInputBytes: transcript.inputBytes ?? null,
    transcriptRequestDurationMs: transcript.requestDurationMs ?? null,
    transcriptProviderQueueDelayMs: transcript.providerQueueDelayMs ?? null,
    transcriptProviderExecutionMs: transcript.providerExecutionMs ?? null,
    transcriptPromptTokens: transcript.promptTokens ?? null,
    transcriptCompletionTokens: transcript.completionTokens ?? null,
    transcriptTotalTokens: transcript.totalTokens ?? null,
    classificationProvider: detection.provider,
    classificationModel: detection.model,
    classificationRequestDurationMs: detection.requestDurationMs ?? null,
    classificationPromptTokens: detection.promptTokens ?? null,
    classificationCompletionTokens: detection.completionTokens ?? null,
    classificationTotalTokens: detection.totalTokens ?? null,
    totalEstimatedCostUsd: totalEstimatedCost,
    adSpanCount: detection.spans.length,
    queueDelayMs: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
    batchWindowSeconds: message.batchWindowSeconds ?? null,
    bytesWritten: audioOutput.bytesWritten,
    audioRewriteMode: audioOutput.manifest.mode,
    sourceDurationMs: audioOutput.manifest.sourceDurationMs,
    cleanedDurationMs: audioOutput.manifest.cleanedDurationMs,
    removedDurationMs,
    splicePlanKey
  };

  await markJobComplete(
    env.DB,
    message,
    audioOutput.key,
    transcriptKey,
    adSpansKey,
    JSON.stringify(processingDetails)
  );

  await capturePostHogEvent(env, distinctId, "episode_processing_completed", {
    episode_id: episode.id,
    feed_id: episode.feed_id,
    bytes_written: audioOutput.bytesWritten,
    total_estimated_cost_usd: totalEstimatedCost,
    ad_span_count: detection.spans.length,
    audio_rewrite_mode: audioOutput.manifest.mode,
    removed_duration_ms: removedDurationMs,
    queue_delay_ms: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
    batch_window_seconds: message.batchWindowSeconds ?? null,
    transcript_provider_queue_delay_ms: transcript.providerQueueDelayMs ?? null,
    transcript_provider_execution_ms: transcript.providerExecutionMs ?? null,
    processing_total_ms: Date.now() - startedAt
  });
}

export type EpisodeJobResult =
  | { kind: "ack" }
  | { kind: "retry"; delaySeconds: number };

export async function handleEpisodeJob(env: Env, message: EpisodeJobMessage): Promise<EpisodeJobResult> {
  try {
    await processEpisodeJob(env, message);
    return { kind: "ack" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown episode processing failure";

    if (isRetryableProcessingError(error)) {
      const delaySeconds = getRetryDelaySeconds(error, 60);

      await markJobQueuedForRetry(env.DB, message, errorMessage);
      await capturePostHogEvent(env, `episode:${message.episodeId}`, "episode_processing_retry_scheduled", {
        episode_id: message.episodeId,
        feed_id: message.feedId,
        error: errorMessage,
        retry_delay_seconds: delaySeconds,
        batch_window_seconds: message.batchWindowSeconds ?? null
      });

      return {
        kind: "retry",
        delaySeconds
      };
    }

    await markJobFailed(env.DB, message, errorMessage);
    await capturePostHogEvent(env, `episode:${message.episodeId}`, "episode_processing_failed", {
      episode_id: message.episodeId,
      feed_id: message.feedId,
      error: errorMessage,
      batch_window_seconds: message.batchWindowSeconds ?? null
    });
    return { kind: "ack" };
  }
}
