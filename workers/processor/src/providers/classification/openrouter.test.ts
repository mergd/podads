import { describe, expect, test } from "bun:test";

import { buildAdClassificationPrompt, msAtSegmentOffset } from "./openrouter";
import type { TranscriptResult, TranscriptSegment } from "../../lib/types";

const transcript: TranscriptResult = {
  provider: "test",
  model: "test",
  text: "A small transcript.",
  segments: [{ startMs: 0, endMs: 1_000, text: "A small transcript." }],
  estimatedCostUsd: 0,
  analysisWindowMs: null,
  analyzedDurationMs: 1_000,
  analysisTruncated: false
};

describe("buildAdClassificationPrompt", () => {
  test("keeps show-owned promotion while enclosing sponsored capsules and full creative", () => {
    const prompt = buildAdClassificationPrompt(transcript);

    expect(prompt).toContain("show's own events, merchandise, games, newsletters, memberships, and websites");
    expect(prompt).toContain("dialogue and setup immediately before the brand name");
    expect(prompt).toContain("introduced and closed as 'brought to you by [brand]'");
    expect(prompt).toContain("including any news report or editorial-sounding material between its sponsor bookends");
    expect(prompt).toContain("Scan the entire transcript through the final timestamp");
    expect(prompt).toContain("word timestamps when available");
    expect(prompt).toContain("explicit thank-you to named sponsors");
  });
});

describe("msAtSegmentOffset", () => {
  test("uses word timestamps instead of interpolating across a long segment", () => {
    const segment: TranscriptSegment = {
      startMs: 1_000,
      endMs: 21_000,
      text: "editorial words ad copy",
      words: [
        { startMs: 1_000, endMs: 1_300, text: "editorial" },
        { startMs: 1_400, endMs: 1_700, text: "words" },
        { startMs: 18_000, endMs: 18_500, text: "ad" },
        { startMs: 18_600, endMs: 19_100, text: "copy" }
      ]
    };

    expect(msAtSegmentOffset(segment, 0.5, "start")).toBe(18_000);
    expect(msAtSegmentOffset(segment, 0.5, "end")).toBe(1_700);
  });
});
