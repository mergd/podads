import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { refineAdSpans } from "../lib/adDetection";
import type { AdSpan, TranscriptResult } from "../lib/types";
import { runOpenRouterClassificationModel } from "../providers/classification/openrouter";
import { AD_BENCH_CASES, type BenchCase } from "./cases";
import { mean, scoreSpans, stddev, type SpanScore, type TimeRange } from "./score";

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const benchRoot = dirname(currentFile);
const workspaceRoot = resolve(benchRoot, "../../../..");
const apiWranglerConfigPath = resolve(workspaceRoot, "workers/api/wrangler.jsonc");
const cacheDir = resolve(benchRoot, ".cache");
const DEFAULT_RUNS = 5;
const DEFAULT_MODELS = [
  "qwen/qwen3.7-flash",
  "deepseek/deepseek-v4-flash-0731",
  "openai/gpt-oss-120b",
  "google/gemini-3.1-flash-lite",
  "openai/gpt-5.6-luna"
] as const;

/** OpenRouter list prices, USD per 1M tokens. Used when usage.cost is 0. */
const LIST_PRICE_PER_M: Record<string, { input: number; output: number }> = {
  "qwen/qwen3.7-flash": { input: 0.03, output: 0.13 },
  "deepseek/deepseek-v4-flash-0731": { input: 0.08, output: 0.18 },
  "openai/gpt-oss-120b": { input: 0.037, output: 0.17 },
  "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2 }
};

interface Args {
  runs: number;
  models: string[];
  caseIds: string[];
  outputFile?: string;
}

interface GoldFile {
  caseId: string;
  spans: Array<TimeRange & { label?: string }>;
}

interface RunResult {
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

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runs: DEFAULT_RUNS,
    models: [...DEFAULT_MODELS],
    caseIds: AD_BENCH_CASES.map((entry) => entry.id)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "--runs":
        args.runs = next ? Number.parseInt(next, 10) : DEFAULT_RUNS;
        index += 1;
        break;
      case "--models":
        args.models = next ? next.split(",").map((value) => value.trim()).filter(Boolean) : args.models;
        index += 1;
        break;
      case "--cases":
        args.caseIds = next ? next.split(",").map((value) => value.trim()).filter(Boolean) : args.caseIds;
        index += 1;
        break;
      case "--output-file":
        args.outputFile = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(args.runs) || args.runs < 1) {
    throw new Error("--runs must be a positive integer.");
  }

  return args;
}

async function loadGold(caseId: string): Promise<GoldFile> {
  const parsed = JSON.parse(await readFile(join(benchRoot, "gold", `${caseId}.json`), "utf8")) as GoldFile;
  return parsed;
}

async function runWrangler(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("wrangler", args, {
    cwd: workspaceRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  return `${stdout}${stderr}`.trim();
}

async function loadTranscript(benchCase: BenchCase): Promise<TranscriptResult> {
  await mkdir(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, benchCase.transcriptKey.replaceAll("/", "_"));

  try {
    return JSON.parse(await readFile(cacheFile, "utf8")) as TranscriptResult;
  } catch {
    await runWrangler([
      "r2",
      "object",
      "get",
      `podads-audio/${benchCase.transcriptKey}`,
      "--remote",
      "--file",
      cacheFile
    ]);
    return JSON.parse(await readFile(cacheFile, "utf8")) as TranscriptResult;
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function estimateCostUsd(model: string, billedCostUsd: number, promptTokens?: number, completionTokens?: number): number {
  if (billedCostUsd > 0) {
    return billedCostUsd;
  }

  const prices = LIST_PRICE_PER_M[model];
  if (!prices || promptTokens == null || completionTokens == null) {
    return billedCostUsd;
  }

  return (promptTokens * prices.input + completionTokens * prices.output) / 1_000_000;
}

function summarize(results: RunResult[], models: string[], caseIds: string[]) {
  const rows = models.map((model) => {
    const ok = results.filter((result) => result.model === model && result.status === "ok" && result.score);
    const f1s = ok.map((result) => result.score!.f1);
    const leftovers = ok.map((result) => result.score!.leftoverMs);
    const overcuts = ok.map((result) => result.score!.overcutMs);
    const costs = ok.map((result) => result.estimatedCostUsd ?? 0);
    const cases = caseIds.map((caseId) => {
      const caseRuns = ok.filter((result) => result.caseId === caseId);
      const caseF1s = caseRuns.map((result) => result.score!.f1);
      return {
        caseId,
        passed: caseRuns.length > 0 && caseRuns.every((result) => result.score!.passed),
        passRate: caseRuns.length === 0 ? 0 : caseRuns.filter((result) => result.score!.passed).length / caseRuns.length,
        f1: mean(caseF1s),
        leftoverMs: mean(caseRuns.map((result) => result.score!.leftoverMs)),
        overcutMs: mean(caseRuns.map((result) => result.score!.overcutMs))
      };
    });
    const passedCases = cases.filter((entry) => entry.passed).length;

    return {
      model,
      passedCases,
      caseCount: caseIds.length,
      f1: mean(f1s),
      f1Std: stddev(f1s),
      leftoverMs: mean(leftovers),
      overcutMs: mean(overcuts),
      costUsd: mean(costs),
      errors: results.filter((result) => result.model === model && result.status === "error").length,
      cases
    };
  });

  return rows.sort((left, right) => right.f1 - left.f1 || left.costUsd - right.costUsd);
}

function printTable(rows: ReturnType<typeof summarize>): void {
  const header = `${"model".padEnd(36)} ${"pass".padStart(6)} ${"f1".padStart(6)} ${"σf1".padStart(6)} ${"left".padStart(8)} ${"over".padStart(8)} ${"$/run".padStart(9)}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      `${row.model.padEnd(36)} ${`${row.passedCases}/${row.caseCount}`.padStart(6)} ${row.f1.toFixed(2).padStart(6)} ${row.f1Std.toFixed(2).padStart(6)} ${formatSeconds(row.leftoverMs).padStart(8)} ${formatSeconds(row.overcutMs).padStart(8)} ${formatUsd(row.costUsd).padStart(9)}${row.errors > 0 ? `  ${row.errors} err` : ""}`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selectedCases = AD_BENCH_CASES.filter((entry) => args.caseIds.includes(entry.id));
  if (selectedCases.length === 0) {
    throw new Error(`No matching cases. Known ids: ${AD_BENCH_CASES.map((entry) => entry.id).join(", ")}`);
  }

  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY.");
  }

  const env = {
    OPENROUTER_API_KEY: openRouterApiKey,
    APP_BASE_URL: "https://podads.yet-to-be.com"
  } as Env;

  const transcripts = new Map<string, TranscriptResult>();
  const goldByCase = new Map<string, TimeRange[]>();
  for (const benchCase of selectedCases) {
    transcripts.set(benchCase.id, await loadTranscript(benchCase));
    goldByCase.set(benchCase.id, (await loadGold(benchCase.id)).spans);
  }

  const results: RunResult[] = [];
  for (const model of args.models) {
    for (const benchCase of selectedCases) {
      const transcript = transcripts.get(benchCase.id);
      const gold = goldByCase.get(benchCase.id);
      if (!transcript || !gold) {
        throw new Error(`Missing fixtures for ${benchCase.id}`);
      }

      for (let run = 1; run <= args.runs; run += 1) {
        process.stderr.write(`${model} ${benchCase.id} run ${run}/${args.runs}\n`);
        try {
          const raw = await runOpenRouterClassificationModel(env, model, transcript, {
            mentionPrerolls: true
          });
          const spans = refineAdSpans(raw.spans, transcript) as AdSpan[];
          const score = scoreSpans(spans, gold);
          results.push({
            model,
            caseId: benchCase.id,
            run,
            status: "ok",
            score,
            billedCostUsd: raw.estimatedCostUsd,
            estimatedCostUsd: estimateCostUsd(
              model,
              raw.estimatedCostUsd,
              raw.promptTokens,
              raw.completionTokens
            ),
            promptTokens: raw.promptTokens,
            completionTokens: raw.completionTokens,
            requestDurationMs: raw.requestDurationMs,
            spanCount: spans.length,
            spans: spans.map((span) => ({ startMs: span.startMs, endMs: span.endMs }))
          });
        } catch (error) {
          results.push({
            model,
            caseId: benchCase.id,
            run,
            status: "error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  const summary = summarize(results, args.models, selectedCases.map((entry) => entry.id));
  console.log(
    `\nad-bench  cases=${selectedCases.map((entry) => entry.id).join(",")}  runs=${args.runs}  models=${args.models.length}\n`
  );
  printTable(summary);

  const output = {
    runs: args.runs,
    cases: selectedCases,
    models: args.models,
    summary,
    results
  };
  const outputFile = args.outputFile
    ? resolve(process.cwd(), args.outputFile)
    : join(cacheDir, `ad-bench-${Date.now()}.json`);
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outputFile}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
