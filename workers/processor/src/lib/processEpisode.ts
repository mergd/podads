import type { EpisodeProcessingSubstatus } from "@podads/shared/api";
import { MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS } from "@podads/shared/queue";

import { detectAdSpans } from "./adDetection";
import { rewriteAudio } from "./audioRewrite";
import { notifyEpisodeProcessingFailure } from "./discord";
import { capturePostHogAiGeneration, capturePostHogEvent } from "./posthog";
import { getNextRetryAttempt, getRetryDelaySeconds, isRetryableProcessingError } from "./retryable";
import { generateTranscript } from "./transcription";
import type { AdSpan, AudioRewriteManifest, EpisodeJobMessage, EpisodeRecord, TranscriptResult } from "./types";

type ProcessingDetails = Record<string, unknown>;
type PreviewSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

const TRANSCRIPT_PREVIEW_SEGMENT_LIMIT = 6;
const OPENING_SIGNAL_WINDOW_MS = 5 * 60 * 1000;
const NO_ADS_EPISODE_STREAK_THRESHOLD = 3;
const SPONSOR_SIGNAL_PATTERNS = [
  { label: "brought_to_you_by", pattern: /\bbrought to you by\b/i },
  { label: "presented_by", pattern: /\bpresented by\b/i },
  { label: "sponsored_by", pattern: /\bsponsored by\b/i },
  { label: "support_from", pattern: /\bsupport (?:for|from)\b/i },
  { label: "thanks_to_our_sponsor", pattern: /\bthanks to (?:our|today's) sponsor\b/i },
  { label: "promo_code", pattern: /\bpromo code\b/i },
  { label: "offer_code", pattern: /\boffer code\b/i },
  { label: "use_code", pattern: /\buse code\b/i },
  { label: "visit_url", pattern: /\b(?:visit|go to)\s+[a-z0-9.-]+\.[a-z]{2,}\b/i },
  { label: "free_trial", pattern: /\bfree trial\b/i }
] as const;

function truncatePreviewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function buildTranscriptPreview(segments: TranscriptResult["segments"]): PreviewSegment[] {
  return segments.slice(0, TRANSCRIPT_PREVIEW_SEGMENT_LIMIT).map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: truncatePreviewText(segment.text)
  }));
}

function detectOpeningSponsorSignals(transcript: TranscriptResult): string[] {
  const openingText = transcript.segments
    .filter((segment) => segment.startMs < OPENING_SIGNAL_WINDOW_MS)
    .map((segment) => segment.text)
    .join(" ");

  return SPONSOR_SIGNAL_PATTERNS.flatMap(({ label, pattern }) => (pattern.test(openingText) ? [label] : []));
}

function buildTranscriptDiagnostics(transcript: TranscriptResult): ProcessingDetails {
  return {
    transcriptSegmentCount: transcript.segments.length,
    transcriptAnalysisWindowMs: transcript.analysisWindowMs,
    transcriptAnalyzedDurationMs: transcript.analyzedDurationMs,
    transcriptAnalysisTruncated: transcript.analysisTruncated,
    transcriptOpeningPreview: buildTranscriptPreview(transcript.segments),
    transcriptOpeningSponsorSignals: detectOpeningSponsorSignals(transcript)
  };
}

function buildDetectionDiagnostics(transcript: TranscriptResult, detectionSpans: Array<{ startMs: number; reason: string }>): ProcessingDetails {
  return {
    adSpanCount: detectionSpans.length,
    openingAdSpanCount: detectionSpans.filter((span) => span.startMs < OPENING_SIGNAL_WINDOW_MS).length,
    adDetectionReasons: detectionSpans
      .map((span) => span.reason.trim())
      .filter((reason) => reason.length > 0)
      .slice(0, 6),
    transcriptOpeningSponsorSignals: detectOpeningSponsorSignals(transcript)
  };
}

function buildRewriteDiagnostics(manifest: AudioRewriteManifest, removedDurationMs: number | null): ProcessingDetails {
  return {
    audioRewriteMode: manifest.mode,
    removedDurationMs,
    rewriteNotes: manifest.notes
  };
}

function mergeSpanDurations(spans: AdSpan[]): number {
  if (spans.length === 0) {
    return 0;
  }

  const sorted = [...spans].sort((left, right) => left.startMs - right.startMs);
  let totalMs = 0;
  let currentStartMs = sorted[0]?.startMs ?? 0;
  let currentEndMs = sorted[0]?.endMs ?? 0;

  for (const span of sorted.slice(1)) {
    if (span.startMs <= currentEndMs) {
      currentEndMs = Math.max(currentEndMs, span.endMs);
      continue;
    }

    totalMs += currentEndMs - currentStartMs;
    currentStartMs = span.startMs;
    currentEndMs = span.endMs;
  }

  totalMs += currentEndMs - currentStartMs;
  return totalMs;
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }

  return numerator / denominator;
}

function logEpisodeProcessingDiagnostics(
  level: "info" | "warn",
  event: string,
  episodeId: number,
  feedId: number,
  details: ProcessingDetails
): void {
  const payload = JSON.stringify({
    event,
    episodeId,
    feedId,
    ...details
  });

  switch (level) {
    case "info":
      console.info(payload);
      return;
    case "warn":
      console.warn(payload);
      return;
    default: {
      const exhaustiveCheck: never = level;
      throw new Error(`Unhandled log level: ${String(exhaustiveCheck)}`);
    }
  }
}

function parseProcessingDetails(value: string): ProcessingDetails {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProcessingDetails)
      : {};
  } catch {
    return {};
  }
}

function parseFeedHasAdsState(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }
  }

  return null;
}

function parseAdSpanCount(details: ProcessingDetails): number | null {
  const value = details.adSpanCount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withProcessingSubstatus(
  details: ProcessingDetails,
  substatus: EpisodeProcessingSubstatus | null,
  timestamp: string,
  extra: ProcessingDetails = {}
): ProcessingDetails {
  return {
    ...details,
    ...extra,
    processingSubstatus: substatus,
    processingSubstatusUpdatedAt: timestamp
  };
}

async function updateEpisodeProcessingDetails(
  db: D1Database,
  episodeId: number,
  details: ProcessingDetails,
  updatedAt: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE episodes
      SET processing_details_json = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(episodeId, JSON.stringify(details), updatedAt)
    .run();
}

async function loadRecentReadyEpisodeAdSpanCounts(
  db: D1Database,
  feedId: number,
  limit: number
): Promise<number[]> {
  if (limit <= 0) {
    return [];
  }

  const rows = await db
    .prepare(
      `SELECT processing_details_json
      FROM episodes
      WHERE feed_id = ?1
        AND processing_status = 'ready'
      ORDER BY
        COALESCE(pub_date_ms, CAST(strftime('%s', created_at) AS INTEGER) * 1000) DESC,
        COALESCE(CAST(strftime('%s', last_processed_at) AS INTEGER) * 1000, -1) DESC,
        CAST(strftime('%s', updated_at) AS INTEGER) * 1000 DESC,
        id DESC
      LIMIT ?2`
    )
    .bind(feedId, limit)
    .all<{ processing_details_json: string }>();

  return rows.results.flatMap((row) => {
    const adSpanCount = parseAdSpanCount(parseProcessingDetails(row.processing_details_json));
    return adSpanCount === null ? [] : [adSpanCount];
  });
}

async function syncFeedHasAdsState(
  db: D1Database,
  feedId: number,
  currentState: boolean | null,
  updatedAt: string
): Promise<boolean | null> {
  const recentAdSpanCounts = await loadRecentReadyEpisodeAdSpanCounts(db, feedId, NO_ADS_EPISODE_STREAK_THRESHOLD);
  const shouldMarkFeedNoAds =
    recentAdSpanCounts.length === NO_ADS_EPISODE_STREAK_THRESHOLD
    && recentAdSpanCounts.every((count) => count === 0);
  const shouldMarkFeedHasAds = recentAdSpanCounts.some((count) => count > 0);
  const nextState = shouldMarkFeedNoAds ? false : shouldMarkFeedHasAds ? true : currentState;

  if (nextState === currentState) {
    return currentState;
  }

  await db
    .prepare(
      `UPDATE feeds
      SET has_ads = ?2, updated_at = ?3
      WHERE id = ?1`
    )
    .bind(feedId, nextState === null ? null : nextState ? 1 : 0, updatedAt)
    .run();

  return nextState;
}

async function loadEpisode(db: D1Database, episodeId: number): Promise<EpisodeRecord | null> {
  const episode = await db
    .prepare(
      `SELECT
        episodes.id,
        episodes.feed_id,
        episodes.title,
        feeds.title AS feed_title,
        feeds.slug AS feed_slug,
        feeds.has_ads,
        episodes.source_enclosure_url,
        episodes.source_enclosure_type,
        episodes.source_enclosure_length,
        episodes.processing_status,
        episodes.processing_details_json
      FROM episodes
      INNER JOIN feeds ON feeds.id = episodes.feed_id
      WHERE episodes.id = ?1
      LIMIT 1`
    )
    .bind(episodeId)
    .first<EpisodeRecord>();

  return episode ?? null;
}

async function markJobProcessing(
  db: D1Database,
  message: EpisodeJobMessage,
  processingDetailsJson: string
): Promise<void> {
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
      SET processing_status = 'processing', processing_version = ?2, processing_details_json = ?3, last_error = NULL, updated_at = ?4
      WHERE id = ?1`
    )
    .bind(message.episodeId, message.processingVersion, processingDetailsJson, now)
    .run();
}

async function markJobFailed(
  db: D1Database,
  message: EpisodeJobMessage,
  errorMessage: string,
  processingDetailsJson: string
): Promise<void> {
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
      SET processing_status = 'failed', processing_details_json = ?2, last_error = ?3, updated_at = ?4
      WHERE id = ?1`
    )
    .bind(message.episodeId, processingDetailsJson, errorMessage, now)
    .run();
}

async function markJobSkipped(
  db: D1Database,
  message: EpisodeJobMessage,
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
        processing_status = 'skipped',
        processing_details_json = ?2,
        last_error = NULL,
        last_processed_at = ?3,
        updated_at = ?3
      WHERE id = ?1`
    )
    .bind(message.episodeId, processingDetailsJson, now)
    .run();
}

async function markJobQueuedForRetry(
  db: D1Database,
  message: EpisodeJobMessage,
  retryMessage: EpisodeJobMessage,
  errorMessage: string,
  processingDetailsJson: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE jobs
      SET status = 'queued', last_error = ?2, payload_json = ?3, updated_at = ?4
      WHERE id = ?1`
    )
    .bind(message.jobId, errorMessage, JSON.stringify(retryMessage), now)
    .run();

  await db
    .prepare(
      `UPDATE episodes
      SET processing_status = 'pending', processing_details_json = ?2, last_error = ?3, updated_at = ?4
      WHERE id = ?1`
    )
    .bind(message.episodeId, processingDetailsJson, errorMessage, now)
    .run();
}

async function markJobComplete(
  db: D1Database,
  message: EpisodeJobMessage,
  cleanedEnclosureKey: string | null,
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

  const distinctId = `episode:${episode.id}`;
  const queueDelayMs = Date.now() - Date.parse(message.enqueuedAt);
  const processingStartedAt = new Date().toISOString();
  const baseProcessingDetails = parseProcessingDetails(episode.processing_details_json);
  const feedHasAdsState = parseFeedHasAdsState(episode.has_ads);

  if (feedHasAdsState === false) {
    const skippedProcessingDetails = JSON.stringify(
      withProcessingSubstatus(baseProcessingDetails, null, processingStartedAt, {
        currentJobId: message.jobId,
        enqueuedAt: message.enqueuedAt,
        queueAttempt: message.pollAttempt ?? 0,
        queueDelayMs: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
        skippedAt: processingStartedAt,
        skippedReason: "feed_marked_no_ads"
      })
    );

    await markJobSkipped(env.DB, message, skippedProcessingDetails);
    logEpisodeProcessingDiagnostics("info", "episode_skipped_no_ads_feed", episode.id, episode.feed_id, {
      skippedReason: "feed_marked_no_ads"
    });
    await capturePostHogEvent(env, distinctId, "episode_processing_skipped", {
      episode_id: episode.id,
      feed_id: episode.feed_id,
      reason: "feed_marked_no_ads",
      queue_delay_ms: Number.isFinite(queueDelayMs) ? queueDelayMs : null
    });
    return;
  }

  let processingDetails = withProcessingSubstatus(baseProcessingDetails, "transcribing", processingStartedAt, {
    currentJobId: message.jobId,
    enqueuedAt: message.enqueuedAt,
    queueAttempt: message.pollAttempt ?? 0,
    queueDelayMs: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
    processingStartedAt
  });

  await markJobProcessing(env.DB, message, JSON.stringify(processingDetails));

  const transcript = await generateTranscript(env, episode, message.processingVersion, {});
  const transcriptDiagnostics = buildTranscriptDiagnostics(transcript);
  logEpisodeProcessingDiagnostics("info", "episode_transcript_diagnostics", episode.id, episode.feed_id, transcriptDiagnostics);
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
    feed_id: episode.feed_id,
    feed_title: episode.feed_title ?? null,
    feed_slug: episode.feed_slug ?? null
  });
  await capturePostHogAiGeneration(env, distinctId, {
    traceId: `episode:${episode.id}`,
    spanName: "transcription",
    provider: transcript.provider,
    model: transcript.model,
    inputTokens: transcript.promptTokens ?? null,
    outputTokens: transcript.completionTokens ?? null,
    totalTokens: transcript.totalTokens ?? null,
    totalCostUsd: transcript.estimatedCostUsd ?? null,
    latencySeconds:
      typeof transcript.requestDurationMs === "number" ? transcript.requestDurationMs / 1000 : null,
    feedId: episode.feed_id,
    feedTitle: episode.feed_title ?? null,
    feedSlug: episode.feed_slug ?? null,
    episodeId: episode.id,
    episodeTitle: episode.title ?? null
  });

  {
    const detectingAdsAt = new Date().toISOString();
    processingDetails = withProcessingSubstatus(processingDetails, "detecting_ads", detectingAdsAt, {
      transcriptCompletedAt: detectingAdsAt,
      transcriptProvider: transcript.provider,
      transcriptModel: transcript.model,
      transcriptRequestDurationMs: transcript.requestDurationMs ?? null,
      transcriptProviderQueueDelayMs: transcript.providerQueueDelayMs ?? null,
      transcriptProviderExecutionMs: transcript.providerExecutionMs ?? null,
      ...transcriptDiagnostics
    });
    await updateEpisodeProcessingDetails(env.DB, message.episodeId, processingDetails, detectingAdsAt);
  }

  const detection = await detectAdSpans(env, transcript, {
    episodeTitle: episode.title,
    feedTitle: episode.feed_title ?? null,
    feedSlug: episode.feed_slug ?? null
  });
  const detectedDurationMs = mergeSpanDurations(detection.spans);
  const detectedOpeningDurationMs = mergeSpanDurations(
    detection.spans.map((span) => ({
      ...span,
      endMs: Math.min(span.endMs, OPENING_SIGNAL_WINDOW_MS)
    })).filter((span) => span.endMs > span.startMs)
  );
  const detectionDiagnostics = buildDetectionDiagnostics(transcript, detection.spans);
  logEpisodeProcessingDiagnostics("info", "episode_ad_detection_diagnostics", episode.id, episode.feed_id, {
    classificationProvider: detection.provider,
    classificationModel: detection.model,
    ...detectionDiagnostics
  });
  if (detection.spans.length === 0) {
    logEpisodeProcessingDiagnostics("warn", "episode_zero_ad_spans_detected", episode.id, episode.feed_id, {
      classificationProvider: detection.provider,
      classificationModel: detection.model,
      ...transcriptDiagnostics,
      ...detectionDiagnostics
    });
  }
  await capturePostHogEvent(env, distinctId, "ad_detection_completed", {
    provider: detection.provider,
    model: detection.model,
    estimated_cost_usd: detection.estimatedCostUsd,
    ad_span_count: detection.spans.length,
    detected_duration_ms: detectedDurationMs,
    detected_opening_duration_ms: detectedOpeningDurationMs,
    detected_ratio_of_analyzed_audio: safeRatio(detectedDurationMs, transcript.analyzedDurationMs),
    detected_opening_ratio_of_analyzed_audio: safeRatio(detectedOpeningDurationMs, transcript.analyzedDurationMs),
    request_duration_ms: detection.requestDurationMs,
    prompt_tokens: detection.promptTokens,
    completion_tokens: detection.completionTokens,
    total_tokens: detection.totalTokens,
    episode_id: episode.id,
    feed_id: episode.feed_id,
    feed_title: episode.feed_title ?? null,
    feed_slug: episode.feed_slug ?? null
  });
  await capturePostHogAiGeneration(env, distinctId, {
    traceId: `episode:${episode.id}`,
    spanName: "ad_detection",
    provider: detection.provider,
    model: detection.model,
    inputTokens: detection.promptTokens ?? null,
    outputTokens: detection.completionTokens ?? null,
    totalTokens: detection.totalTokens ?? null,
    totalCostUsd: detection.estimatedCostUsd ?? null,
    latencySeconds:
      typeof detection.requestDurationMs === "number" ? detection.requestDurationMs / 1000 : null,
    feedId: episode.feed_id,
    feedTitle: episode.feed_title ?? null,
    feedSlug: episode.feed_slug ?? null,
    episodeId: episode.id,
    episodeTitle: episode.title ?? null
  });

  {
    const rewritingAudioAt = new Date().toISOString();
    processingDetails = withProcessingSubstatus(processingDetails, "rewriting_audio", rewritingAudioAt, {
      adDetectionCompletedAt: rewritingAudioAt,
      classificationProvider: detection.provider,
      classificationModel: detection.model,
      classificationRequestDurationMs: detection.requestDurationMs ?? null,
      ...detectionDiagnostics
    });
    await updateEpisodeProcessingDetails(env.DB, message.episodeId, processingDetails, rewritingAudioAt);
  }

  const transcriptKey = `transcripts/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;
  const adSpansKey = `ad-spans/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;
  const splicePlanKey = `splice-plans/${episode.feed_id}/${episode.id}/${message.processingVersion}.json`;
  const sourceEnclosureLength =
    episode.source_enclosure_length && /^\d+$/.test(episode.source_enclosure_length)
      ? Number.parseInt(episode.source_enclosure_length, 10)
      : null;

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
    sourceEnclosureLength,
    episode.feed_id,
    episode.id,
    message.processingVersion,
    detection.spans
  );
  await putJsonArtifact(env.AUDIO_BUCKET, splicePlanKey, audioOutput.manifest, {
    episodeId: String(episode.id),
    feedId: String(episode.feed_id)
  });

  {
    const finalizingAt = new Date().toISOString();
    processingDetails = withProcessingSubstatus(processingDetails, "finalizing", finalizingAt, {
      audioRewriteCompletedAt: finalizingAt,
      transcriptKey,
      adSpansKey,
      splicePlanKey,
      bytesWritten: audioOutput.bytesWritten,
      audioRewriteMode: audioOutput.manifest.mode
    });
    await updateEpisodeProcessingDetails(env.DB, message.episodeId, processingDetails, finalizingAt);
  }

  const totalEstimatedCost = transcript.estimatedCostUsd + detection.estimatedCostUsd;
  const removedDurationMs =
    audioOutput.manifest.sourceDurationMs !== null && audioOutput.manifest.cleanedDurationMs !== null
      ? audioOutput.manifest.sourceDurationMs - audioOutput.manifest.cleanedDurationMs
      : null;
  const removedRatioOfSource = safeRatio(removedDurationMs, audioOutput.manifest.sourceDurationMs);
  const removedRatioOfAnalyzedAudio = safeRatio(removedDurationMs, transcript.analyzedDurationMs);
  const rewriteDiagnostics = buildRewriteDiagnostics(audioOutput.manifest, removedDurationMs);
  logEpisodeProcessingDiagnostics("info", "episode_audio_rewrite_diagnostics", episode.id, episode.feed_id, rewriteDiagnostics);
  const completedAt = new Date().toISOString();
  const finalProcessingDetails = {
    ...processingDetails,
    processingSubstatus: null,
    processingSubstatusUpdatedAt: completedAt,
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
    queueDelayMs: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
    bytesWritten: audioOutput.bytesWritten,
    sourceDurationMs: audioOutput.manifest.sourceDurationMs,
    cleanedDurationMs: audioOutput.manifest.cleanedDurationMs,
    splicePlanKey,
    ...transcriptDiagnostics,
    ...detectionDiagnostics,
    ...rewriteDiagnostics
  };

  await markJobComplete(
    env.DB,
    message,
    audioOutput.key,
    transcriptKey,
    adSpansKey,
    JSON.stringify(finalProcessingDetails)
  );

  const nextFeedHasAdsState = await syncFeedHasAdsState(env.DB, episode.feed_id, feedHasAdsState, completedAt);

  await capturePostHogEvent(env, distinctId, "episode_processing_completed", {
    episode_id: episode.id,
    feed_id: episode.feed_id,
    bytes_written: audioOutput.bytesWritten,
    total_estimated_cost_usd: totalEstimatedCost,
    ad_span_count: detection.spans.length,
    detected_duration_ms: detectedDurationMs,
    detected_opening_duration_ms: detectedOpeningDurationMs,
    audio_rewrite_mode: audioOutput.manifest.mode,
    source_duration_ms: audioOutput.manifest.sourceDurationMs,
    cleaned_duration_ms: audioOutput.manifest.cleanedDurationMs,
    removed_duration_ms: removedDurationMs,
    removed_ratio_of_source: removedRatioOfSource,
    removed_ratio_of_analyzed_audio: removedRatioOfAnalyzedAudio,
    feed_has_ads: nextFeedHasAdsState,
    queue_delay_ms: Number.isFinite(queueDelayMs) ? queueDelayMs : null,
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
    const now = new Date().toISOString();
    const processingAttemptCount = Math.max(1, (message.pollAttempt ?? 0) + 1);
    const retryableError = isRetryableProcessingError(error);
    const retryLimitReached = retryableError && processingAttemptCount >= MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS;
    const failureProcessingDetails = JSON.stringify(
      withProcessingSubstatus({}, null, now, {
        currentJobId: message.jobId,
        failedAt: now,
        queueAttempt: message.pollAttempt ?? 0,
        processingAttemptCount,
        maxAutomaticProcessingAttempts: MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS,
        retryLimitReachedAt: retryLimitReached ? now : null
      })
    );

    if (retryableError && !retryLimitReached) {
      const nextRetryAttempt = getNextRetryAttempt(message.pollAttempt);
      const delaySeconds = getRetryDelaySeconds(error, 60, nextRetryAttempt, message.episodeId);
      const retryNotBeforeAt = new Date(Date.now() + (delaySeconds * 1000)).toISOString();
      const retryMessage: EpisodeJobMessage = {
        ...message,
        enqueuedAt: now,
        pollAttempt: nextRetryAttempt
      };
      const retryProcessingDetails = JSON.stringify(
        withProcessingSubstatus({}, "retry_scheduled", now, {
          currentJobId: message.jobId,
          retryDelaySeconds: delaySeconds,
          retryScheduledAt: now,
          retryNotBeforeAt,
          queueAttempt: nextRetryAttempt,
          processingAttemptCount,
          maxAutomaticProcessingAttempts: MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS
        })
      );

      await markJobQueuedForRetry(env.DB, message, retryMessage, errorMessage, retryProcessingDetails);
      await capturePostHogEvent(env, `episode:${message.episodeId}`, "episode_processing_retry_scheduled", {
        episode_id: message.episodeId,
        feed_id: message.feedId,
        error: errorMessage,
        retry_delay_seconds: delaySeconds,
        retry_not_before_at: retryNotBeforeAt,
        processing_attempt_count: processingAttemptCount
      });

      return {
        kind: "retry",
        delaySeconds
      };
    }

    await markJobFailed(env.DB, message, errorMessage, failureProcessingDetails);
    const episode = await loadEpisode(env.DB, message.episodeId);
    await notifyEpisodeProcessingFailure(env, message, errorMessage, episode);
    await capturePostHogEvent(env, `episode:${message.episodeId}`, "episode_processing_failed", {
      episode_id: message.episodeId,
      feed_id: message.feedId,
      error: errorMessage,
      processing_attempt_count: processingAttemptCount
    });
    return { kind: "ack" };
  }
}
