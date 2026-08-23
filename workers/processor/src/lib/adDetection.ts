import { mockClassification } from "../providers/classification/mock";
import {
  OPENROUTER_CLASSIFICATION_MODEL,
  openRouterClassification
} from "../providers/classification/openrouter";
import type {
  AdDetectionContext,
  AdDetectionResult,
  AdSpan,
  TranscriptResult,
  TranscriptSegment
} from "./types";

type ClassificationProvider = "mock" | "openrouter";
const DEFAULT_AD_SPAN_MAX_DURATION_MS = 6 * 60 * 1000;
const LEX_FRIDMAN_AD_SPAN_MAX_DURATION_MS = 12 * 60 * 1000;
const SNAP_WINDOW_MS = 5_000;
const MIN_SILENCE_GAP_MS = 80;
const INTERIOR_SNAP_GUARD_MS = 400;
const SEGMENT_EXPANSION_GAP_MS = 2_500;
const MAX_EDGE_EXPANSION_SEGMENTS = 3;
const MAX_EDGE_SEGMENT_DURATION_MS = 8_000;
const DISCLAIMER_SIGNAL_PATTERNS = [
  /\brestrictions apply\b/i,
  /\bterms apply\b/i,
  /\bmember (?:nyse|sipc)\b/i,
  /\bdoes not verify\b/i,
  /\binvest(?:ing)? involves risk\b/i,
  /\bpast performance\b/i
] as const;
const PROMOTIONAL_SIGNAL_PATTERNS = [
  /\bsupport(?:ed)? by\b/i,
  /\bsponsor(?:ed|ship)?\b/i,
  /\bpromo code\b/i,
  /\boffer code\b/i,
  /\bvisit\b.+\.[a-z]{2,}\b/i,
  /\bgo to\b.+\.[a-z]{2,}\b/i,
  /\bfree trial\b/i,
  /\bmember (?:nyse|sipc)\b/i,
  /\bterms apply\b/i,
  /\blearn more\b/i,
  /\bbest rates\b/i,
  /\bbook your stay\b/i,
  /\bfor business\b/i,
  /\bget smarter\b/i,
  /\bresults\b/i,
  /\bwith acrobat\b/i,
  /\bpublic\.com\b/i,
  /\bibm\b/i,
  /\bfidelity\b/i,
  /\bokta\b/i,
  /\bchase\b/i,
  /\bsonesta|sinesta\b/i
] as const;
const EDITORIAL_STOP_PATTERNS = [
  /\bhello and welcome\b/i,
  /\bwelcome back\b/i,
  /\bi(?:'| a)m\b.+\b(?:tracy|joe)\b/i,
  /\bthis is odd lots\b/i,
  /\btoday on\b/i,
  /\bour guest\b/i,
  /\bjoining us\b/i,
  /\bwe'?re joined\b/i,
  /\blet'?s get to\b/i,
  /\bsubscribe to\b/i,
  /\bjoin the conversation\b/i,
  /\bbloomberg audio studios\b/i,
  /\bpodcasts\. radio\. news\b/i
] as const;

function assertNever(value: never): never {
  throw new Error(`Unhandled classification provider: ${value}`);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceToRange(target: number, startMs: number, endMs: number): number {
  if (target >= startMs && target <= endMs) {
    return 0;
  }

  return target < startMs ? startMs - target : target - endMs;
}

function snapToNearestGap(target: number, transcript: TranscriptResult, mode: "start" | "end"): number {
  const candidates: number[] = [];

  for (let index = 1; index < transcript.segments.length; index += 1) {
    const previous = transcript.segments[index - 1];
    const next = transcript.segments[index];
    if (!previous || !next) {
      continue;
    }

    const gapStartMs = previous.endMs;
    const gapEndMs = next.startMs;
    if (gapEndMs - gapStartMs < MIN_SILENCE_GAP_MS) {
      continue;
    }

    if (distanceToRange(target, gapStartMs, gapEndMs) > SNAP_WINDOW_MS) {
      continue;
    }

    candidates.push(clampNumber(target, gapStartMs, gapEndMs));
  }

  for (const segment of transcript.segments) {
    if (mode === "start") {
      const isInterior = target > segment.startMs + INTERIOR_SNAP_GUARD_MS && target < segment.endMs;
      if (isInterior || Math.abs(segment.startMs - target) > SNAP_WINDOW_MS) {
        continue;
      }

      candidates.push(segment.startMs);
      continue;
    }

    const isInterior = target < segment.endMs - INTERIOR_SNAP_GUARD_MS && target > segment.startMs;
    if (isInterior || Math.abs(segment.endMs - target) > SNAP_WINDOW_MS) {
      continue;
    }

    candidates.push(segment.endMs);
  }

  if (candidates.length === 0) {
    return target;
  }

  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest
  );
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLexFridmanFeed(context: AdDetectionContext): boolean {
  const haystack = [context.feedTitle, context.feedSlug]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .replace(/[-_]+/g, " ")
    .toLowerCase();

  return haystack.includes("lex fridman");
}

function getAdSpanMaxDurationMs(context: AdDetectionContext): number {
  return isLexFridmanFeed(context)
    ? LEX_FRIDMAN_AD_SPAN_MAX_DURATION_MS
    : DEFAULT_AD_SPAN_MAX_DURATION_MS;
}

function isPromotionalSegment(text: string): boolean {
  const normalized = normalizeText(text);
  return PROMOTIONAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isDisclaimerSegment(text: string): boolean {
  const normalized = normalizeText(text);
  return DISCLAIMER_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isEditorialStopSegment(text: string): boolean {
  const normalized = normalizeText(text);
  return EDITORIAL_STOP_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldExpandIntoSegment(
  segment: TranscriptSegment,
  anchorSegment: TranscriptSegment
): boolean {
  const gapFromAnchorMs = Math.abs(anchorSegment.startMs - segment.endMs);
  const durationMs = segment.endMs - segment.startMs;

  if (gapFromAnchorMs > SEGMENT_EXPANSION_GAP_MS || durationMs > MAX_EDGE_SEGMENT_DURATION_MS) {
    return false;
  }

  if (isEditorialStopSegment(segment.text)) {
    return false;
  }

  return isPromotionalSegment(segment.text) || isDisclaimerSegment(segment.text);
}

function expandSpanEdges(span: AdSpan, transcript: TranscriptResult): AdSpan {
  const overlappingSegmentIndices = transcript.segments.flatMap((segment, index) =>
    segment.endMs >= span.startMs && segment.startMs <= span.endMs ? [index] : []
  );
  const firstOverlapIndex = overlappingSegmentIndices[0];
  const lastOverlapIndex = overlappingSegmentIndices[overlappingSegmentIndices.length - 1];

  if (firstOverlapIndex === undefined || lastOverlapIndex === undefined) {
    return span;
  }

  let startIndex = firstOverlapIndex;
  let endIndex = lastOverlapIndex;

  for (let expanded = 0; expanded < MAX_EDGE_EXPANSION_SEGMENTS; expanded += 1) {
    const previousIndex = startIndex - 1;
    const previousSegment = transcript.segments[previousIndex];
    const currentSegment = transcript.segments[startIndex];

    if (!previousSegment || !currentSegment) {
      break;
    }

    if (!shouldExpandIntoSegment(previousSegment, currentSegment)) {
      break;
    }

    startIndex = previousIndex;
  }

  for (let expanded = 0; expanded < MAX_EDGE_EXPANSION_SEGMENTS; expanded += 1) {
    const nextIndex = endIndex + 1;
    const nextSegment = transcript.segments[nextIndex];
    const currentSegment = transcript.segments[endIndex];

    if (!nextSegment || !currentSegment) {
      break;
    }

    const gapFromAnchorMs = Math.abs(nextSegment.startMs - currentSegment.endMs);
    const durationMs = nextSegment.endMs - nextSegment.startMs;

    if (gapFromAnchorMs > SEGMENT_EXPANSION_GAP_MS || durationMs > MAX_EDGE_SEGMENT_DURATION_MS) {
      break;
    }

    if (isEditorialStopSegment(nextSegment.text)) {
      break;
    }

    if (!isPromotionalSegment(nextSegment.text) && !isDisclaimerSegment(nextSegment.text)) {
      break;
    }

    endIndex = nextIndex;
  }

  return {
    ...span,
    startMs:
      startIndex === firstOverlapIndex
        ? span.startMs
        : (transcript.segments[startIndex]?.startMs ?? span.startMs),
    endMs:
      endIndex === lastOverlapIndex
        ? span.endMs
        : (transcript.segments[endIndex]?.endMs ?? span.endMs)
  };
}

function mergeSpans(spans: AdSpan[]): AdSpan[] {
  if (spans.length === 0) {
    return [];
  }

  const sorted = [...spans].sort((left, right) => left.startMs - right.startMs);
  const merged: AdSpan[] = [{ ...sorted[0]! }];

  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...span });
      continue;
    }

    if (span.startMs <= last.endMs + SEGMENT_EXPANSION_GAP_MS) {
      last.endMs = Math.max(last.endMs, span.endMs);
      last.confidence = Math.max(last.confidence, span.confidence);
      last.reason = `${last.reason} | ${span.reason}`;
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

function refineSpanBoundaries(spans: AdSpan[], transcript: TranscriptResult): AdSpan[] {
  const snappedSpans = spans.map((span) => ({
    ...span,
    startMs: snapToNearestGap(span.startMs, transcript, "start"),
    endMs: snapToNearestGap(span.endMs, transcript, "end")
  }));

  const expandedSpans = snappedSpans.map((span) => expandSpanEdges(span, transcript));
  return mergeSpans(expandedSpans);
}

function capSpanDurations(spans: AdSpan[], maxDurationMs: number): AdSpan[] {
  return spans
    .map((span) => {
      const cappedEndMs = Math.min(span.endMs, span.startMs + maxDurationMs);

      if (cappedEndMs <= span.startMs) {
        return null;
      }

      return cappedEndMs === span.endMs
        ? span
        : {
            ...span,
            endMs: cappedEndMs,
            reason: `${span.reason} | capped_to_max_duration`
          };
    })
    .filter((span): span is AdSpan => span !== null);
}

export async function detectAdSpans(
  env: Env,
  transcript: TranscriptResult,
  context: AdDetectionContext = {}
): Promise<AdDetectionResult> {
  const provider = env.CLASSIFICATION_PROVIDER as ClassificationProvider;
  const maxSpanDurationMs = getAdSpanMaxDurationMs(context);
  let result: AdDetectionResult;

  switch (provider) {
    case "mock":
      result = await mockClassification(OPENROUTER_CLASSIFICATION_MODEL, transcript.segments);
      break;
    case "openrouter":
      result = await openRouterClassification(env, transcript, {
        mentionPrerolls: true,
        maxSpanDurationMs
      });
      break;
    default:
      result = assertNever(provider);
      break;
  }

  return {
    ...result,
    spans: refineAdSpans(result.spans, transcript, maxSpanDurationMs)
  };
}

export function refineAdSpans(
  spans: AdSpan[],
  transcript: TranscriptResult,
  maxDurationMs: number = DEFAULT_AD_SPAN_MAX_DURATION_MS
): AdSpan[] {
  return capSpanDurations(refineSpanBoundaries(spans, transcript), maxDurationMs);
}
