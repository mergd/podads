import mp3Parser, { type Mp3FrameDescription } from "mp3-parser";

import type { AdSpan, AudioRewriteManifest, TimeRange } from "./types";

const MP3_CONTENT_TYPES = new Set(["audio/mpeg", "audio/mp3"]);
const FRAME_MERGE_EPSILON_MS = 0.5;

export interface ParsedFrame {
  offset: number;
  byteLength: number;
  startMs: number;
  endMs: number;
}

export interface ParsedMp3 {
  prefixByteLength: number;
  frames: ParsedFrame[];
  sourceDurationMs: number;
  hasXingTag: boolean;
}

function clampRange(range: TimeRange, maxDurationMs: number): TimeRange | null {
  const startMs = Math.max(0, Math.min(range.startMs, maxDurationMs));
  const endMs = Math.max(0, Math.min(range.endMs, maxDurationMs));

  if (endMs <= startMs) {
    return null;
  }

  return { startMs, endMs };
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const first = sorted[0];

  if (!first) {
    return [];
  }

  const merged: TimeRange[] = [{ ...first }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];

    if (!last) {
      merged.push({ ...range });
      continue;
    }

    if (range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
      continue;
    }

    merged.push({ ...range });
  }

  return merged;
}

function invertRanges(
  sourceDurationMs: number,
  removedRanges: TimeRange[],
): TimeRange[] {
  const retainedRanges: TimeRange[] = [];
  let cursor = 0;

  for (const range of removedRanges) {
    if (range.startMs > cursor) {
      retainedRanges.push({ startMs: cursor, endMs: range.startMs });
    }

    cursor = Math.max(cursor, range.endMs);
  }

  if (cursor < sourceDurationMs) {
    retainedRanges.push({ startMs: cursor, endMs: sourceDurationMs });
  }

  return retainedRanges;
}

function collapseRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const first = ranges[0];

  if (!first) {
    return [];
  }

  const collapsed: TimeRange[] = [{ ...first }];

  for (const range of ranges.slice(1)) {
    const last = collapsed[collapsed.length - 1];

    if (!last) {
      collapsed.push({ ...range });
      continue;
    }

    if (range.startMs <= last.endMs + FRAME_MERGE_EPSILON_MS) {
      last.endMs = Math.max(last.endMs, range.endMs);
      continue;
    }

    collapsed.push({ ...range });
  }

  return collapsed;
}

function isRangeOverlapping(left: TimeRange, right: TimeRange): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function frameDurationMs(frame: Mp3FrameDescription): number {
  const sampleLength = frame._section.sampleLength;
  const samplingRate = frame.header.samplingRate;

  if (!sampleLength || !samplingRate) {
    throw new Error("MP3 frame did not include timing metadata.");
  }

  return (sampleLength / samplingRate) * 1000;
}

function findFirstFrame(
  view: DataView,
  startOffset: number,
): Mp3FrameDescription | null {
  for (let offset = startOffset; offset < view.byteLength; offset += 1) {
    if (view.getUint8(offset) !== 0xff) {
      continue;
    }

    const frame = mp3Parser.readFrame(view, offset, false);

    if (frame) {
      return frame;
    }
  }

  return null;
}

export function parseMp3Audio(buffer: ArrayBuffer): ParsedMp3 {
  const view = new DataView(buffer);
  const id3Tag = mp3Parser.readId3v2Tag(view, 0);
  const scanOffset = id3Tag?._section.byteLength ?? 0;
  const firstFrame = findFirstFrame(view, scanOffset);

  if (!firstFrame) {
    throw new Error("Could not locate an MP3 frame in the source audio.");
  }

  const frames: ParsedFrame[] = [];
  let cursor = firstFrame._section.offset;
  let timelineMs = 0;

  while (cursor < view.byteLength) {
    const frame = mp3Parser.readFrame(view, cursor, false);

    if (!frame) {
      break;
    }

    const durationMs = frameDurationMs(frame);
    frames.push({
      offset: frame._section.offset,
      byteLength: frame._section.byteLength,
      startMs: timelineMs,
      endMs: timelineMs + durationMs,
    });
    timelineMs += durationMs;
    cursor = frame._section.offset + frame._section.byteLength;
  }

  if (frames.length === 0) {
    throw new Error("Could not parse any MP3 frames from the source audio.");
  }

  return {
    prefixByteLength: firstFrame._section.offset,
    frames,
    sourceDurationMs: timelineMs,
    hasXingTag: Boolean(
      mp3Parser.readXingTag(view, firstFrame._section.offset),
    ),
  };
}

function buildOutputBytes(
  sourceBytes: Uint8Array,
  prefixByteLength: number,
  frames: ParsedFrame[],
): Uint8Array {
  const totalFrameBytes = frames.reduce(
    (sum, frame) => sum + frame.byteLength,
    0,
  );
  const output = new Uint8Array(prefixByteLength + totalFrameBytes);
  output.set(sourceBytes.subarray(0, prefixByteLength), 0);

  let cursor = prefixByteLength;

  for (const frame of frames) {
    const frameBytes = sourceBytes.subarray(
      frame.offset,
      frame.offset + frame.byteLength,
    );
    output.set(frameBytes, cursor);
    cursor += frame.byteLength;
  }

  return output;
}

export function canSpliceMp3(contentType: string): boolean {
  return MP3_CONTENT_TYPES.has(contentType.toLowerCase());
}

export function spliceMp3Audio(
  buffer: ArrayBuffer,
  contentType: string,
  adSpans: AdSpan[],
): { bytes: Uint8Array; manifest: AudioRewriteManifest } {
  const parsed = parseMp3Audio(buffer);
  const normalizedRemovedRanges = mergeRanges(
    adSpans
      .map((span) =>
        clampRange(
          { startMs: span.startMs, endMs: span.endMs },
          parsed.sourceDurationMs,
        ),
      )
      .filter((range): range is TimeRange => range !== null),
  );

  if (normalizedRemovedRanges.length === 0) {
    throw new Error("No removable MP3 ranges were supplied.");
  }

  const retainedRanges = invertRanges(
    parsed.sourceDurationMs,
    normalizedRemovedRanges,
  );

  if (retainedRanges.length === 0) {
    throw new Error("Ad spans covered the entire MP3.");
  }

  const framesEligibleForOutput = parsed.hasXingTag
    ? parsed.frames.slice(1)
    : parsed.frames;
  const keptFrames = framesEligibleForOutput.filter((frame) =>
    retainedRanges.some((range) =>
      isRangeOverlapping(range, { startMs: frame.startMs, endMs: frame.endMs }),
    ),
  );

  if (keptFrames.length === 0) {
    throw new Error("No MP3 frames remained after applying the ad spans.");
  }

  const actualRetainedRanges = collapseRanges(
    keptFrames.map((frame) => ({
      startMs: frame.startMs,
      endMs: frame.endMs,
    })),
  );
  const actualRemovedRanges = invertRanges(
    parsed.sourceDurationMs,
    actualRetainedRanges,
  );
  const cleanedDurationMs = actualRetainedRanges.reduce(
    (sum, range) => sum + (range.endMs - range.startMs),
    0,
  );
  const output = buildOutputBytes(
    new Uint8Array(buffer),
    parsed.prefixByteLength,
    keptFrames,
  );
  const notes: string[] = [];

  if (parsed.hasXingTag) {
    notes.push(
      "Dropped the leading Xing/LAME frame so VBR metadata does not lie about the rewritten output.",
    );
  }

  return {
    bytes: output,
    manifest: {
      mode: "mp3-frame-splice",
      sourceContentType: contentType,
      sourceDurationMs: parsed.sourceDurationMs,
      cleanedDurationMs,
      requestedRemovedRanges: normalizedRemovedRanges,
      actualRemovedRanges,
      retainedRanges: actualRetainedRanges,
      frameCount: parsed.frames.length,
      keptFrameCount: keptFrames.length,
      notes,
    },
  };
}
