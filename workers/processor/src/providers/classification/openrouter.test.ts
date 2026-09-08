import { describe, expect, test } from "bun:test";

import { buildAdClassificationPrompt } from "./openrouter";
import type { TranscriptResult } from "../../lib/types";

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
  });
});
