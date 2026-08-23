export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface SpanScore {
  predictedMs: number;
  goldMs: number;
  intersectionMs: number;
  leftoverMs: number;
  overcutMs: number;
  precision: number;
  recall: number;
  f1: number;
  passed: boolean;
}

const EMPTY_PASS_OVERCUT_MS = 5_000;
const LEFTOVER_PASS_MS = 30_000;
const OVERCUT_PASS_MS = 45_000;
const F1_PASS = 0.8;

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs);

  if (sorted.length === 0) {
    return [];
  }

  const merged: TimeRange[] = [{ ...sorted[0]! }];
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

export function rangeDurationMs(ranges: TimeRange[]): number {
  return mergeRanges(ranges).reduce((sum, range) => sum + (range.endMs - range.startMs), 0);
}

export function intersectRanges(left: TimeRange[], right: TimeRange[]): number {
  const a = mergeRanges(left);
  const b = mergeRanges(right);
  let total = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const currentA = a[i];
    const currentB = b[j];
    if (!currentA || !currentB) {
      break;
    }

    const start = Math.max(currentA.startMs, currentB.startMs);
    const end = Math.min(currentA.endMs, currentB.endMs);
    if (end > start) {
      total += end - start;
    }

    if (currentA.endMs < currentB.endMs) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return total;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 1 : numerator / denominator;
}

export function scoreSpans(predicted: TimeRange[], gold: TimeRange[]): SpanScore {
  const predictedMs = rangeDurationMs(predicted);
  const goldMs = rangeDurationMs(gold);
  const intersectionMs = intersectRanges(predicted, gold);
  const leftoverMs = goldMs - intersectionMs;
  const overcutMs = predictedMs - intersectionMs;
  const precision = safeRatio(intersectionMs, predictedMs);
  const recall = safeRatio(intersectionMs, goldMs);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const passed =
    goldMs === 0
      ? overcutMs <= EMPTY_PASS_OVERCUT_MS
      : leftoverMs <= LEFTOVER_PASS_MS && overcutMs <= OVERCUT_PASS_MS && f1 >= F1_PASS;

  return {
    predictedMs,
    goldMs,
    intersectionMs,
    leftoverMs,
    overcutMs,
    precision,
    recall,
    f1,
    passed
  };
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
