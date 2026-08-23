import type { BenchCase } from "./cases";
import type { SpanScore, TimeRange } from "./score";

export interface CaseSummary {
  caseId: string;
  passed: boolean;
  passRate: number;
  f1: number;
  leftoverMs: number;
  overcutMs: number;
}

export interface ModelSummary {
  model: string;
  passedCases: number;
  caseCount: number;
  f1: number;
  f1Std: number;
  leftoverMs: number;
  overcutMs: number;
  costUsd: number;
  errors: number;
  cases: CaseSummary[];
}

export interface RunResult {
  model: string;
  caseId: string;
  run: number;
  status: "ok" | "error";
  score?: SpanScore;
  estimatedCostUsd?: number;
  billedCostUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  requestDurationMs?: number;
  spanCount?: number;
  spans?: TimeRange[];
  error?: string;
}

export interface BenchOutput {
  generatedAt?: string;
  status: "running" | "complete";
  runs: number;
  cases: BenchCase[];
  models: string[];
  summary: ModelSummary[];
  results: RunResult[];
}
