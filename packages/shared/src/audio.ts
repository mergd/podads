import mp3Parser, { type Mp3FrameDescription } from "mp3-parser";

const MP3_CONTENT_TYPES = new Set(["audio/mpeg", "audio/mp3"]);
const FRAME_MERGE_EPSILON_MS = 0.5;

export const AUDIO_REWRITE_MANIFEST_HEADER = "x-podads-rewrite-manifest";
export const AUDIO_REWRITE_BYTES_WRITTEN_HEADER = "x-podads-bytes-written";
export const AUDIO_REWRITE_SOURCE_BYTES_HEADER = "x-podads-source-bytes";
export const AUDIO_REWRITE_DOWNLOAD_MS_HEADER = "x-podads-download-ms";
export const AUDIO_REWRITE_EXECUTION_MS_HEADER = "x-podads-rewrite-ms";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface AudioRewriteManifest {
  mode: "mp3-frame-splice" | "passthrough";
  sourceContentType: string;
  sourceDurationMs: number | null;
  cleanedDurationMs: number | null;
  requestedRemovedRanges: TimeRange[];
  actualRemovedRanges: TimeRange[];
  retainedRanges: TimeRange[];
  frameCount: number | null;
  keptFrameCount: number | null;
  notes: string[];
}

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

interface OutputFrameSegment {
  bytes: Uint8Array;
  offset: number;
  byteLength: number;
}

interface SkipCueAudio {
  bytes: Uint8Array;
  frames: ParsedFrame[];
  durationMs: number;
}

function toBase64(binary: string): string {
  return btoa(binary);
}

function fromBase64(base64: string): string {
  return atob(base64);
}

export function encodeManifestHeader(manifest: AudioRewriteManifest): string {
  const json = JSON.stringify(manifest);
  const bytes = new TextEncoder().encode(json);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return toBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeManifestHeader(value: string): AudioRewriteManifest {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = fromBase64(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);

  return JSON.parse(json) as AudioRewriteManifest;
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

  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs);
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

function invertRanges(sourceDurationMs: number, removedRanges: TimeRange[]): TimeRange[] {
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

function findFirstFrame(view: DataView, startOffset: number): Mp3FrameDescription | null {
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
      endMs: timelineMs + durationMs
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
    hasXingTag: Boolean(mp3Parser.readXingTag(view, firstFrame._section.offset))
  };
}

function buildOutputBytes(sourceBytes: Uint8Array, prefixByteLength: number, segments: OutputFrameSegment[]): Uint8Array {
  const totalFrameBytes = segments.reduce((sum, segment) => sum + segment.byteLength, 0);
  const output = new Uint8Array(prefixByteLength + totalFrameBytes);
  output.set(sourceBytes.subarray(0, prefixByteLength), 0);

  let cursor = prefixByteLength;

  for (const segment of segments) {
    const frameBytes = segment.bytes.subarray(segment.offset, segment.offset + segment.byteLength);
    output.set(frameBytes, cursor);
    cursor += segment.byteLength;
  }

  return output;
}

function parseSkipCueAudio(bytes: Uint8Array | undefined): SkipCueAudio | null {
  if (!bytes) {
    return null;
  }

  const parsed = parseMp3Audio(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  return {
    bytes,
    frames: parsed.frames,
    durationMs: parsed.sourceDurationMs
  };
}

function toOutputSegment(bytes: Uint8Array, frame: ParsedFrame): OutputFrameSegment {
  return {
    bytes,
    offset: frame.offset,
    byteLength: frame.byteLength
  };
}

function hasRemovedAudioBeforeFrame(
  frame: ParsedFrame,
  previousFrame: ParsedFrame | undefined,
  removedRanges: TimeRange[]
): boolean {
  const gapStartMs = previousFrame?.endMs ?? 0;
  const gapEndMs = frame.startMs;

  if (gapEndMs <= gapStartMs + FRAME_MERGE_EPSILON_MS) {
    return false;
  }

  return removedRanges.some((range) => isRangeOverlapping(range, { startMs: gapStartMs, endMs: gapEndMs }));
}

function buildOutputFramesWithSkipCues(
  sourceBytes: Uint8Array,
  keptFrames: ParsedFrame[],
  removedRanges: TimeRange[],
  cue: SkipCueAudio | null
): { segments: OutputFrameSegment[]; cueCount: number; cueDurationMs: number } {
  const segments: OutputFrameSegment[] = [];
  let previousSourceFrame: ParsedFrame | undefined;
  let cueCount = 0;
  let cueDurationMs = 0;

  for (const frame of keptFrames) {
    if (cue && hasRemovedAudioBeforeFrame(frame, previousSourceFrame, removedRanges)) {
      for (const cueFrame of cue.frames) {
        segments.push(toOutputSegment(cue.bytes, cueFrame));
      }
      cueCount += 1;
      cueDurationMs += cue.durationMs;
    }

    segments.push(toOutputSegment(sourceBytes, frame));
    previousSourceFrame = frame;
  }

  return { segments, cueCount, cueDurationMs };
}

export function canSpliceMp3(contentType: string): boolean {
  return MP3_CONTENT_TYPES.has(contentType.toLowerCase());
}

export function spliceMp3Audio(
  buffer: ArrayBuffer,
  contentType: string,
  adSpans: Array<{ startMs: number; endMs: number }>,
  options: { skipCueBytes?: Uint8Array } = {}
): { bytes: Uint8Array; manifest: AudioRewriteManifest } {
  const parsed = parseMp3Audio(buffer);
  const normalizedRemovedRanges = mergeRanges(
    adSpans
      .map((span) => clampRange({ startMs: span.startMs, endMs: span.endMs }, parsed.sourceDurationMs))
      .filter((range): range is TimeRange => range !== null)
  );

  if (normalizedRemovedRanges.length === 0) {
    throw new Error("No removable MP3 ranges were supplied.");
  }

  const retainedRanges = invertRanges(parsed.sourceDurationMs, normalizedRemovedRanges);

  if (retainedRanges.length === 0) {
    throw new Error("Ad spans covered the entire MP3.");
  }

  const framesEligibleForOutput = parsed.hasXingTag ? parsed.frames.slice(1) : parsed.frames;
  const keptFrames = framesEligibleForOutput.filter((frame) =>
    retainedRanges.some((range) =>
      isRangeOverlapping(range, { startMs: frame.startMs, endMs: frame.endMs })
    )
  );

  if (keptFrames.length === 0) {
    throw new Error("No MP3 frames remained after applying the ad spans.");
  }

  const actualRetainedRanges = collapseRanges(
    keptFrames.map((frame) => ({
      startMs: frame.startMs,
      endMs: frame.endMs
    }))
  );
  const actualRemovedRanges = invertRanges(parsed.sourceDurationMs, actualRetainedRanges);
  const sourceBytes = new Uint8Array(buffer);
  const outputFrames = buildOutputFramesWithSkipCues(
    sourceBytes,
    keptFrames,
    normalizedRemovedRanges,
    parseSkipCueAudio(options.skipCueBytes)
  );
  const cleanedDurationMs =
    actualRetainedRanges.reduce((sum, range) => sum + (range.endMs - range.startMs), 0)
    + outputFrames.cueDurationMs;
  const output = buildOutputBytes(sourceBytes, parsed.prefixByteLength, outputFrames.segments);
  const notes: string[] = [];

  if (parsed.hasXingTag) {
    notes.push("Dropped the leading Xing/LAME frame so VBR metadata does not lie about the rewritten output.");
  }

  if (outputFrames.cueCount > 0) {
    notes.push(`Inserted ${outputFrames.cueCount} short tone cue(s) at ad removal boundaries.`);
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
      notes
    }
  };
}
