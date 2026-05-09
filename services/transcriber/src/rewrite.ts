import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  AUDIO_REWRITE_BYTES_WRITTEN_HEADER,
  AUDIO_REWRITE_DOWNLOAD_MS_HEADER,
  AUDIO_REWRITE_EXECUTION_MS_HEADER,
  AUDIO_REWRITE_MANIFEST_HEADER,
  AUDIO_REWRITE_SOURCE_BYTES_HEADER,
  canSpliceMp3,
  encodeManifestHeader,
  type AudioRewriteManifest
} from "@podads/shared/audio";

import { downloadToTmp } from "./downloads.js";
import { cleanupFile, getFileSizeBytes } from "./speedup.js";

const execFileAsync = promisify(execFile);
const OUTPUT_CONTENT_TYPE = "audio/mpeg";
const OUTPUT_BITRATE = process.env.AUDIO_REWRITE_BITRATE ?? "128k";
const FFMPEG_REWRITE_TIMEOUT_MS = 300_000;
const FFPROBE_TIMEOUT_MS = 30_000;

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

interface TimeRange {
  startMs: number;
  endMs: number;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function clampRange(range: TimeRange, maxDurationMs: number): TimeRange | null {
  const startMs = Math.max(0, Math.min(range.startMs, maxDurationMs));
  const endMs = Math.max(0, Math.min(range.endMs, maxDurationMs));

  return endMs > startMs ? { startMs, endMs } : null;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs);
  const merged: TimeRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

function invertRanges(sourceDurationMs: number, removedRanges: TimeRange[]): TimeRange[] {
  const retainedRanges: TimeRange[] = [];
  let cursorMs = 0;

  for (const range of removedRanges) {
    if (range.startMs > cursorMs) {
      retainedRanges.push({ startMs: cursorMs, endMs: range.startMs });
    }

    cursorMs = Math.max(cursorMs, range.endMs);
  }

  if (cursorMs < sourceDurationMs) {
    retainedRanges.push({ startMs: cursorMs, endMs: sourceDurationMs });
  }

  return retainedRanges;
}

function buildAselectFilter(removedRanges: TimeRange[]): string {
  const removalExpression = removedRanges
    .map((range) => `between(t\\,${seconds(range.startMs)}\\,${seconds(range.endMs)})`)
    .join("+");

  return `aselect=not(${removalExpression}),asetpts=N/SR/TB`;
}

async function getAudioDurationMs(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path
  ], { timeout: FFPROBE_TIMEOUT_MS });

  const durationSeconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not determine audio duration for ${path}`);
  }

  return durationSeconds * 1000;
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

async function rewriteMp3WithFfmpeg(
  inputPath: string,
  adSpans: RewriteSpan[]
): Promise<{ bytes: Uint8Array; manifest: AudioRewriteManifest }> {
  const sourceDurationMs = await getAudioDurationMs(inputPath);
  const removedRanges = mergeRanges(
    adSpans
      .map((span) => clampRange({ startMs: span.startMs, endMs: span.endMs }, sourceDurationMs))
      .filter((range): range is TimeRange => range !== null)
  );

  if (removedRanges.length === 0) {
    throw new Error("No removable MP3 ranges were supplied.");
  }

  const retainedRanges = invertRanges(sourceDurationMs, removedRanges);
  if (retainedRanges.length === 0) {
    throw new Error("Ad spans covered the entire MP3.");
  }

  const outputPath = join(tmpdir(), `rewrite-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-vn",
      "-map", "0:a:0",
      "-af", buildAselectFilter(removedRanges),
      "-codec:a", "libmp3lame",
      "-b:a", OUTPUT_BITRATE,
      outputPath
    ], { timeout: FFMPEG_REWRITE_TIMEOUT_MS });

    const bytes = await readFile(outputPath);
    const cleanedDurationMs = retainedRanges.reduce((sum, range) => sum + (range.endMs - range.startMs), 0);

    return {
      bytes,
      manifest: {
        mode: "ffmpeg-reencode",
        sourceContentType: OUTPUT_CONTENT_TYPE,
        sourceDurationMs,
        cleanedDurationMs,
        requestedRemovedRanges: adSpans.map((span) => ({ startMs: span.startMs, endMs: span.endMs })),
        actualRemovedRanges: removedRanges,
        retainedRanges,
        frameCount: null,
        keptFrameCount: null,
        notes: [
          "Re-encoded retained audio ranges with ffmpeg so podcast clients receive a fresh MP3 stream after ad cuts."
        ]
      }
    };
  } finally {
    await cleanupFile(outputPath);
  }
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

    const rewritten = await rewriteMp3WithFfmpeg(audioPath, input.adSpans);
    return {
      contentType: OUTPUT_CONTENT_TYPE,
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
