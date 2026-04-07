import type { TranscriptResult } from "../../lib/types";

const MOCK_SEGMENTS = [
  { startMs: 0, endMs: 45_000, text: "Welcome back to the show. Today we are talking about markets and macro trends." },
  { startMs: 45_000, endMs: 70_000, text: "This episode is brought to you by our presenting sponsor. Use code PODADS for a discount." },
  { startMs: 70_000, endMs: 120_000, text: "Now back to the interview and the conversation about rates, bonds, and growth." }
] as const;

export async function mockTranscription(model: string, _sourceUrl: string): Promise<TranscriptResult> {
  const segments = MOCK_SEGMENTS.map((segment) => ({ ...segment }));

  return {
    provider: "mock",
    model,
    text: segments.map((segment) => segment.text).join(" "),
    segments,
    estimatedCostUsd: 0
  };
}
