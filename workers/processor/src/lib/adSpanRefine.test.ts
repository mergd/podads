import { describe, expect, test } from "bun:test";

import { refineAdSpans } from "./adDetection";
import type { AdSpan, TranscriptResult, TranscriptSegment } from "./types";

function segment(startMs: number, endMs: number, text: string): TranscriptSegment {
  return { startMs, endMs, text };
}

function transcript(segments: TranscriptSegment[]): TranscriptResult {
  return {
    provider: "test",
    model: "test",
    text: segments.map((entry) => entry.text).join(" "),
    segments,
    estimatedCostUsd: 0,
    analysisWindowMs: null,
    analyzedDurationMs: segments[segments.length - 1]?.endMs ?? 0,
    analysisTruncated: false
  };
}

function span(startMs: number, endMs: number): AdSpan {
  return { startMs, endMs, confidence: 0.9, reason: "test" };
}

describe("refineAdSpans", () => {
  test("keeps an interior model offset instead of snapping back to the line start", () => {
    const mixed = segment(
      860_000,
      879_640,
      "literally living in one of these communities. What if you could use AI to research your"
    );
    const editorial = segment(845_000, 859_960, "Data centers did not rank in the top five issues.");
    const promo = segment(
      879_640,
      923_350,
      "investment portfolio and ask, find profitable mid-cap energy companies with growing cash flow?"
    );
    const startMs = Math.round(860_000 + (879_640 - 860_000) * (3 / 7));

    const [refined] = refineAdSpans(
      [span(startMs, 1_012_670)],
      transcript([editorial, mixed, promo, segment(1_012_670, 1_013_000, "These are sensitive questions.")])
    );

    expect(refined?.startMs).toBe(startMs);
    expect(refined?.startMs).toBeGreaterThan(mixed.startMs + 1_000);
  });

  test("snaps a nearby estimate onto an inter-segment silence gap", () => {
    const before = segment(140_000, 149_800, "come say hi when you're there.");
    const after = segment(155_400, 157_200, "Bloomberg Audio Studios.");
    const [refined] = refineAdSpans([span(152_000, 157_200)], transcript([before, after]));

    expect(refined?.startMs).toBeGreaterThanOrEqual(before.endMs);
    expect(refined?.startMs).toBeLessThanOrEqual(after.startMs);
  });

  test("does not expand backward into interview before a mixed ad line", () => {
    const interview = segment(850_160, 854_920, "I talked to Charles Franklin and Marquette,");
    const mixed = segment(
      860_000,
      879_640,
      "literally living in one of these communities. What if you could use AI to research your"
    );
    const startMs = Math.round(860_000 + (879_640 - 860_000) * (3 / 7));
    const [refined] = refineAdSpans([span(startMs, 879_640)], transcript([interview, mixed]));

    expect(refined?.startMs).toBe(startMs);
  });
});
