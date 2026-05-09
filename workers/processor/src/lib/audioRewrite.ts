import {
  AUDIO_REWRITE_BYTES_WRITTEN_HEADER,
  AUDIO_REWRITE_MANIFEST_HEADER,
  canSpliceMp3,
  decodeManifestHeader
} from "@podads/shared/audio";

import { RetryableProcessingError } from "./retryable";
import type { AdSpan, AudioRewriteManifest, AudioRewriteResult } from "./types";

const GATEWAY_TIMEOUT_MS = 290_000;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 524]);

function extensionFromContentType(contentType: string | null): string {
  switch (contentType) {
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    default:
      return "mp3";
  }
}

function parseContentLength(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const parsed = Number.parseInt(headerValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseRetryAfterSeconds(headerValue: string | null, body: string): number | undefined {
  if (headerValue) {
    const numeric = Number.parseInt(headerValue, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const dateMs = Date.parse(headerValue);
    if (Number.isFinite(dateMs)) {
      const delaySeconds = Math.ceil((dateMs - Date.now()) / 1000);
      if (delaySeconds > 0) {
        return delaySeconds;
      }
    }
  }

  const durationMatch = body.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!durationMatch) {
    return undefined;
  }

  const hours = Number.parseInt(durationMatch[1] ?? "0", 10) || 0;
  const minutes = Number.parseInt(durationMatch[2] ?? "0", 10) || 0;
  const seconds = Number.parseInt(durationMatch[3] ?? "0", 10) || 0;
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

  return totalSeconds > 0 ? totalSeconds : undefined;
}

function buildPutOptions(contentType: string, adSpanCount: number, processingVersion: string, rewriteMode: string) {
  return {
    httpMetadata: {
      contentType
    },
    customMetadata: {
      adSpanCount: String(adSpanCount),
      processingVersion,
      rewriteMode
    }
  };
}

function createPassthroughManifest(contentType: string, adSpans: AdSpan[], note: string): AudioRewriteManifest {
  return {
    mode: "passthrough",
    sourceContentType: contentType,
    sourceDurationMs: null,
    cleanedDurationMs: null,
    requestedRemovedRanges: adSpans.map((span) => ({
      startMs: span.startMs,
      endMs: span.endMs
    })),
    actualRemovedRanges: [],
    retainedRanges: [],
    frameCount: null,
    keptFrameCount: null,
    notes: [note]
  };
}

function createPassthroughResult(contentType: string, adSpans: AdSpan[], note: string): AudioRewriteResult {
  return {
    key: null,
    bytesWritten: 0,
    manifest: createPassthroughManifest(contentType, adSpans, note)
  };
}

async function fetchRewriteFromGateway(url: string, gatewayToken: string | undefined, body: string): Promise<Response> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {})
      },
      body,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
    });

    if (response.ok) {
      return response;
    }

    const text = await response.text();

    if (response.status === 429) {
      throw new RetryableProcessingError(
        `Audio rewrite gateway failed (${response.status}): ${text}`,
        parseRetryAfterSeconds(response.headers.get("retry-after"), text) ?? DEFAULT_RETRY_DELAY_SECONDS
      );
    }

    if (!RETRYABLE_STATUS_CODES.has(response.status)) {
      throw new Error(`Audio rewrite gateway failed (${response.status}): ${text}`);
    }

    throw new RetryableProcessingError(
      `Audio rewrite gateway failed (${response.status}): ${text}`,
      DEFAULT_RETRY_DELAY_SECONDS
    );
  } catch (error) {
    if (error instanceof RetryableProcessingError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes("Audio rewrite gateway failed")) {
      throw error;
    }

    throw new RetryableProcessingError(
      error instanceof Error ? error.message : String(error),
      DEFAULT_RETRY_DELAY_SECONDS
    );
  }
}

async function rewriteAudioViaGateway(
  env: Env,
  sourceUrl: string,
  sourceContentType: string | null,
  key: string,
  processingVersion: string,
  adSpans: AdSpan[]
): Promise<AudioRewriteResult> {
  const baseUrl = env.TRANSCRIPTION_GATEWAY_URL;
  if (!baseUrl) {
    throw new Error("Missing TRANSCRIPTION_GATEWAY_URL configuration.");
  }

  const gatewayResponse = await fetchRewriteFromGateway(
    `${baseUrl.replace(/\/+$/, "")}/v1/audio/rewrite`,
    env.TRANSCRIPTION_GATEWAY_TOKEN,
    JSON.stringify({
      url: sourceUrl,
      source_content_type: sourceContentType,
      ad_spans: adSpans.map((span) => ({
        start_ms: span.startMs,
        end_ms: span.endMs
      }))
    })
  );
  const manifestHeader = gatewayResponse.headers.get(AUDIO_REWRITE_MANIFEST_HEADER);
  if (!manifestHeader) {
    throw new Error("Audio rewrite gateway response was missing manifest metadata.");
  }

  const manifest = decodeManifestHeader(manifestHeader);
  const bytesWritten =
    parseContentLength(gatewayResponse.headers.get(AUDIO_REWRITE_BYTES_WRITTEN_HEADER))
    ?? parseContentLength(gatewayResponse.headers.get("content-length"))
    ?? 0;

  if (!gatewayResponse.body) {
    throw new Error("Audio rewrite gateway succeeded without a readable body.");
  }

  await env.AUDIO_BUCKET.put(
    key,
    gatewayResponse.body,
    buildPutOptions(manifest.sourceContentType, adSpans.length, processingVersion, manifest.mode)
  );

  return {
    key,
    bytesWritten,
    manifest
  };
}

export async function rewriteAudio(
  env: Env,
  sourceUrl: string,
  sourceContentType: string | null,
  _sourceContentLength: number | null,
  feedId: number,
  episodeId: number,
  processingVersion: string,
  adSpans: AdSpan[]
): Promise<AudioRewriteResult> {
  if (adSpans.length === 0) {
    return createPassthroughResult(
      sourceContentType ?? "audio/mpeg",
      adSpans,
      "Skipped audio surgery because no ad spans were detected; serving the source enclosure avoids duplicating bytes in R2."
    );
  }

  if (sourceContentType && !canSpliceMp3(sourceContentType)) {
    return createPassthroughResult(
      sourceContentType,
      adSpans,
      `Skipped audio surgery because ${sourceContentType} is not yet supported for frame-level splicing; serving the source enclosure avoids storing a passthrough copy.`
    );
  }

  if (sourceContentType && canSpliceMp3(sourceContentType) && env.TRANSCRIPTION_GATEWAY_URL) {
    const key = `cleaned/${feedId}/${episodeId}/${processingVersion}.${extensionFromContentType(sourceContentType)}`;
    return rewriteAudioViaGateway(env, sourceUrl, sourceContentType, key, processingVersion, adSpans);
  }

  return createPassthroughResult(
    sourceContentType ?? "audio/mpeg",
    adSpans,
    "Skipped audio surgery because the ffmpeg rewrite gateway is not configured; serving the source enclosure avoids generating fragile MP3 frame-spliced output."
  );
}
