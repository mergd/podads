import {
  AUDIO_REWRITE_BYTES_WRITTEN_HEADER,
  AUDIO_REWRITE_MANIFEST_HEADER,
  canSpliceMp3,
  decodeManifestHeader
} from "@podads/shared/audio";

import { spliceMp3Audio } from "./mp3Surgery";
import { RetryableProcessingError } from "./retryable";
import type { AdSpan, AudioRewriteManifest, AudioRewriteResult } from "./types";

const MAX_IN_MEMORY_AUDIO_REWRITE_BYTES = 30 * 1024 * 1024;
const GATEWAY_TIMEOUT_MS = 290_000;
const MAX_GATEWAY_RETRIES = 2;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504, 524]);

class OversizedAudioRewriteError extends Error {
  sourceBytes: number;

  constructor(sourceBytes: number) {
    super(
      `Audio source ${formatBytes(sourceBytes)} exceeds the Worker in-memory rewrite limit of ${formatBytes(MAX_IN_MEMORY_AUDIO_REWRITE_BYTES)}. Route this episode through Railway-side audio rewrite.`
    );
    this.name = "OversizedAudioRewriteError";
    this.sourceBytes = sourceBytes;
  }
}

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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createOversizedRewriteError(sourceBytes: number): Error {
  return new OversizedAudioRewriteError(sourceBytes);
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

async function readArrayBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = parseContentLength(response.headers.get("content-length"));

  if (contentLength !== null && contentLength > maxBytes) {
    throw createOversizedRewriteError(contentLength);
  }

  if (!response.body) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw createOversizedRewriteError(totalBytes);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged.buffer;
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

async function fetchRewriteFromGateway(url: string, gatewayToken: string | undefined, body: string): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_GATEWAY_RETRIES; attempt += 1) {
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

      lastError = new RetryableProcessingError(
        `Audio rewrite gateway failed (${response.status}): ${text}`,
        DEFAULT_RETRY_DELAY_SECONDS * (attempt + 1)
      );
    } catch (error) {
      if (error instanceof RetryableProcessingError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes("Audio rewrite gateway failed")) {
        throw error;
      }

      lastError = new RetryableProcessingError(
        error instanceof Error ? error.message : String(error),
        DEFAULT_RETRY_DELAY_SECONDS * (attempt + 1)
      );
    }
  }

  throw lastError ?? new RetryableProcessingError("Audio rewrite gateway failed after retries", DEFAULT_RETRY_DELAY_SECONDS);
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
  feedId: number,
  episodeId: number,
  processingVersion: string,
  adSpans: AdSpan[]
): Promise<AudioRewriteResult> {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "podads-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Audio download failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? sourceContentType ?? "audio/mpeg";
  const contentLength = parseContentLength(response.headers.get("content-length"));
  const extension = extensionFromContentType(contentType);
  const key = `cleaned/${feedId}/${episodeId}/${processingVersion}.${extension}`;
  let manifest: AudioRewriteManifest = {
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
    notes: []
  };

  if (adSpans.length === 0) {
    manifest.notes.push("Skipped audio surgery because no ad spans were detected.");
    if (!response.body) {
      throw new Error("Audio download succeeded without a readable body.");
    }
    await env.AUDIO_BUCKET.put(key, response.body, buildPutOptions(contentType, adSpans.length, processingVersion, manifest.mode));
    return {
      key,
      bytesWritten: contentLength ?? 0,
      manifest
    };
  } else if (!canSpliceMp3(contentType)) {
    manifest.notes.push(`Skipped audio surgery because ${contentType} is not yet supported for frame-level splicing.`);
    if (!response.body) {
      throw new Error("Audio download succeeded without a readable body.");
    }
    await env.AUDIO_BUCKET.put(key, response.body, buildPutOptions(contentType, adSpans.length, processingVersion, manifest.mode));
    return {
      key,
      bytesWritten: contentLength ?? 0,
      manifest
    };
  } else {
    if (contentLength !== null && contentLength > MAX_IN_MEMORY_AUDIO_REWRITE_BYTES) {
      return rewriteAudioViaGateway(env, sourceUrl, contentType, key, processingVersion, adSpans);
    }

    try {
      const arrayBuffer = await readArrayBufferWithLimit(response, MAX_IN_MEMORY_AUDIO_REWRITE_BYTES);
      const rewritten = spliceMp3Audio(arrayBuffer, contentType, adSpans);
      manifest = rewritten.manifest;
      await env.AUDIO_BUCKET.put(
        key,
        rewritten.bytes,
        buildPutOptions(contentType, adSpans.length, processingVersion, manifest.mode)
      );
      return {
        key,
        bytesWritten: rewritten.bytes.byteLength,
        manifest
      };
    } catch (error) {
      if (error instanceof OversizedAudioRewriteError) {
        return rewriteAudioViaGateway(env, sourceUrl, contentType, key, processingVersion, adSpans);
      }

      throw error;
    }
  }
}
