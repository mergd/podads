import { canSpliceMp3, spliceMp3Audio } from "./mp3Surgery";
import type { AdSpan, AudioRewriteManifest, AudioRewriteResult } from "./types";

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
  const extension = extensionFromContentType(contentType);
  const key = `cleaned/${feedId}/${episodeId}/${processingVersion}.${extension}`;
  const arrayBuffer = await response.arrayBuffer();
  let bytes: ArrayBuffer | ArrayBufferView = arrayBuffer;
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
  } else if (!canSpliceMp3(contentType)) {
    manifest.notes.push(`Skipped audio surgery because ${contentType} is not yet supported for frame-level splicing.`);
  } else {
    const rewritten = spliceMp3Audio(arrayBuffer, contentType, adSpans);
    bytes = rewritten.bytes;
    manifest = rewritten.manifest;
  }

  await env.AUDIO_BUCKET.put(key, bytes, {
    httpMetadata: {
      contentType
    },
    customMetadata: {
      adSpanCount: String(adSpans.length),
      processingVersion,
      rewriteMode: manifest.mode
    }
  });

  return {
    key,
    bytesWritten: bytes.byteLength,
    manifest
  };
}
