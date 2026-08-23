import { describe, expect, test } from "bun:test";

import { scoreSpans } from "./score";

describe("scoreSpans", () => {
  test("scores a perfect overlap as a pass", () => {
    const gold = [{ startMs: 0, endMs: 10_000 }];
    const score = scoreSpans(gold, gold);
    expect(score.f1).toBe(1);
    expect(score.leftoverMs).toBe(0);
    expect(score.overcutMs).toBe(0);
    expect(score.passed).toBe(true);
  });

  test("fails leftover mid-roll on a no-ads case", () => {
    const score = scoreSpans([{ startMs: 0, endMs: 20_000 }], []);
    expect(score.goldMs).toBe(0);
    expect(score.overcutMs).toBe(20_000);
    expect(score.passed).toBe(false);
  });

  test("passes an empty prediction on a no-ads case", () => {
    const score = scoreSpans([], []);
    expect(score.passed).toBe(true);
    expect(score.f1).toBe(1);
  });
});
