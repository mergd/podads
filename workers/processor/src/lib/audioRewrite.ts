import { canSpliceMp3, spliceMp3Audio } from "./mp3Surgery";
import type { AdSpan, AudioRewriteManifest, AudioRewriteResult } from "./types";

const MAX_IN_MEMORY_AUDIO_REWRITE_BYTES = 30 * 1024 * 1024;

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
  return new Error(
    `Audio source ${formatBytes(sourceBytes)} exceeds the Worker in-memory rewrite limit of ${formatBytes(MAX_IN_MEMORY_AUDIO_REWRITE_BYTES)}. Route this episode through Railway-side audio rewrite.`
  );
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
  }
}
