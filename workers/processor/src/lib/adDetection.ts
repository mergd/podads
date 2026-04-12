import { mockClassification } from "../providers/classification/mock";
import {
  OPENROUTER_CLASSIFICATION_MODEL,
  openRouterClassification
} from "../providers/classification/openrouter";
import type { AdDetectionResult, AdSpan, TranscriptResult } from "./types";

type ClassificationProvider = "mock" | "openrouter";
const SNAP_WINDOW_MS = 5_000;

function assertNever(value: never): never {
  throw new Error(`Unhandled classification provider: ${value}`);
}

function snapToNearestGap(target: number, transcript: TranscriptResult, mode: "start" | "end"): number {
  const nearbySegments = transcript.segments.filter((segment) => Math.abs(segment.startMs - target) <= SNAP_WINDOW_MS);
  const candidates = nearbySegments.map((segment) => (mode === "start" ? segment.startMs : segment.endMs));

  if (candidates.length === 0) {
    return target;
  }

  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest
  );
}

function refineSpanBoundaries(spans: AdSpan[], transcript: TranscriptResult): AdSpan[] {
  return spans.map((span) => ({
    ...span,
    startMs: snapToNearestGap(span.startMs, transcript, "start"),
    endMs: snapToNearestGap(span.endMs, transcript, "end")
  }));
}

export async function detectAdSpans(env: Env, transcript: TranscriptResult): Promise<AdDetectionResult> {
  const provider = env.CLASSIFICATION_PROVIDER as ClassificationProvider;
  let result: AdDetectionResult;

  switch (provider) {
    case "mock":
      result = await mockClassification(OPENROUTER_CLASSIFICATION_MODEL, transcript.segments);
      break;
    case "openrouter":
      result = await openRouterClassification(env, transcript);
      break;
    default:
      result = assertNever(provider);
      break;
  }

  return {
    ...result,
    spans: refineSpanBoundaries(result.spans, transcript)
  };
}
