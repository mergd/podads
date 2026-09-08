import { describe, expect, test } from "bun:test";

import {
  replaceSegmentWithRetry,
  selectSuspiciousGroqSegment
} from "./qualityRetry.js";
import type { TranscriptionResult, TranscriptionSegment } from "./groq.js";

function result(segments: TranscriptionSegment[]): TranscriptionResult {
  return {
    text: segments.map((segment) => segment.text).join(" "),
    segments,
    duration: segments[segments.length - 1]?.end ?? 0,
    provider: "groq",
    model: "whisper-large-v3-turbo",
    estimatedCostUsd: 0.01
  };
}

describe("selectSuspiciousGroqSegment", () => {
  test("selects an anomalously long segment but ignores shorter continuous speech", () => {
    const sparse = { id: 1, start: 100, end: 120.84, text: "before long pause after" };
    const continuous = {
      id: 2,
      start: 130,
      end: 148,
      text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentfive twentysix twentyseven twentyeight twentynine thirty thirtyone thirtytwo"
    };

    expect(selectSuspiciousGroqSegment([continuous, sparse])).toBe(sparse);
  });

  test("retries a segment longer than twenty seconds even when its word density is normal", () => {
    const anomalouslyLong = {
      id: 3,
      start: 200,
      end: 220.84,
      text: Array.from({ length: 60 }, () => "word").join(" ")
    };

    expect(selectSuspiciousGroqSegment([anomalouslyLong])).toBe(anomalouslyLong);
  });
});

describe("replaceSegmentWithRetry", () => {
  test("replaces only the suspicious interval with re-anchored retry timestamps", () => {
    const target = { id: 1, start: 100, end: 120, text: "before after" };
    const initial = result([
      { id: 0, start: 90, end: 99, text: "before" },
      target,
      { id: 2, start: 121, end: 130, text: "after" }
    ]);

    const replacement = replaceSegmentWithRetry(
      initial,
      target,
      [{ id: 0, start: 2, end: 6, text: "recovered" }],
      98,
      0.001
    );

    expect(replacement?.segments.map((segment) => [segment.start, segment.end, segment.text])).toEqual([
      [90, 99, "before"],
      [100, 104, "recovered"],
      [121, 130, "after"]
    ]);
    expect(replacement?.estimatedCostUsd).toBe(0.011);
  });
});
