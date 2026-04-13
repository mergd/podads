import { readFile } from "node:fs/promises";

import {
  AUDIO_REWRITE_BYTES_WRITTEN_HEADER,
  AUDIO_REWRITE_DOWNLOAD_MS_HEADER,
  AUDIO_REWRITE_EXECUTION_MS_HEADER,
  AUDIO_REWRITE_MANIFEST_HEADER,
  AUDIO_REWRITE_SOURCE_BYTES_HEADER,
  canSpliceMp3,
  encodeManifestHeader,
  spliceMp3Audio,
  type AudioRewriteManifest
} from "../../../packages/shared/src/audio.js";

import { downloadToTmp } from "./downloads.js";
import { cleanupFile, getFileSizeBytes } from "./speedup.js";

export interface RewriteSpan {
  startMs: number;
  endMs: number;
}

export interface RewriteAudioRequest {
  url: string;
  sourceContentType: string | null;
  adSpans: RewriteSpan[];
}

export interface RewriteAudioResult {
  contentType: string;
  bytes: Uint8Array;
  manifest: AudioRewriteManifest;
  sourceBytes: number;
  downloadMs: number;
  rewriteMs: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function createPassthroughManifest(contentType: string, adSpans: RewriteSpan[]): AudioRewriteManifest {
  const notes =
    adSpans.length === 0
      ? ["Skipped audio surgery because no ad spans were detected."]
      : [`Skipped audio surgery because ${contentType} is not yet supported for frame-level splicing.`];

  return {
    mode: "passthrough",
    sourceContentType: contentType,
    sourceDurationMs: null,
    cleanedDurationMs: null,
    requestedRemovedRanges: adSpans.map((span) => ({ startMs: span.startMs, endMs: span.endMs })),
    actualRemovedRanges: [],
    retainedRanges: [],
    frameCount: null,
    keptFrameCount: null,
    notes
  };
}

export async function rewriteAudioFromUrl(input: RewriteAudioRequest): Promise<RewriteAudioResult> {
  const downloadStartedAt = Date.now();
  const audioPath = await downloadToTmp(input.url);

  try {
    const downloadMs = Date.now() - downloadStartedAt;
    const sourceBytes = await getFileSizeBytes(audioPath);
    const contentType = input.sourceContentType ?? "audio/mpeg";
    const sourceBuffer = await readFile(audioPath);
    const rewriteStartedAt = Date.now();

    if (input.adSpans.length === 0 || !canSpliceMp3(contentType)) {
      return {
        contentType,
        bytes: sourceBuffer,
        manifest: createPassthroughManifest(contentType, input.adSpans),
        sourceBytes,
        downloadMs,
        rewriteMs: Date.now() - rewriteStartedAt
      };
    }

    const rewritten = spliceMp3Audio(toArrayBuffer(sourceBuffer), contentType, input.adSpans);
    return {
      contentType,
      bytes: rewritten.bytes,
      manifest: rewritten.manifest,
      sourceBytes,
      downloadMs,
      rewriteMs: Date.now() - rewriteStartedAt
    };
  } finally {
    await cleanupFile(audioPath);
  }
}

export function buildRewriteResponseHeaders(result: RewriteAudioResult): Record<string, string> {
  return {
    [AUDIO_REWRITE_MANIFEST_HEADER]: encodeManifestHeader(result.manifest),
    [AUDIO_REWRITE_BYTES_WRITTEN_HEADER]: String(result.bytes.byteLength),
    [AUDIO_REWRITE_SOURCE_BYTES_HEADER]: String(result.sourceBytes),
    [AUDIO_REWRITE_DOWNLOAD_MS_HEADER]: String(result.downloadMs),
    [AUDIO_REWRITE_EXECUTION_MS_HEADER]: String(result.rewriteMs)
  };
}
