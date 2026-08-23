export interface BenchCase {
  id: string;
  episodeId: number;
  feed: string;
  title: string;
  notes: string;
  tags: string[];
}

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

export interface BenchOutput {
  generatedAt?: string;
  status: "running" | "complete";
  runs: number;
  cases: BenchCase[];
  models: string[];
  summary: ModelSummary[];
  results: unknown[];
}
