import { describe, expect, test } from "bun:test";

import { attachWordsToSegments, type TranscriptionSegment, type TranscriptionWord } from "./groq.js";

describe("attachWordsToSegments", () => {
  test("keeps word timestamps with their containing segment", () => {
    const segments: TranscriptionSegment[] = [
      { id: 0, start: 10, end: 14, text: "First segment." },
      { id: 1, start: 14, end: 18, text: "Second segment." }
    ];
    const words: TranscriptionWord[] = [
      { start: 10.1, end: 10.6, text: "First" },
      { start: 10.7, end: 11.2, text: "segment" },
      { start: 14.2, end: 14.8, text: "Second" },
      { start: 14.9, end: 15.5, text: "segment" }
    ];

    const attached = attachWordsToSegments(segments, words);

    expect(attached[0]?.words).toEqual(words.slice(0, 2));
    expect(attached[1]?.words).toEqual(words.slice(2));
  });
});
