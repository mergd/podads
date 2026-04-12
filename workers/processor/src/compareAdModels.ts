import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runOpenRouterClassificationModel } from "./providers/classification/openrouter";
import type { AdSpan, TranscriptResult } from "./lib/types";

const execFileAsync = promisify(execFile);
const DEFAULT_MODELS = [
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
  "openai/gpt-5.4",
  "qwen/qwen3.6-plus"
] as const;
const OPENING_WINDOW_MS = 2 * 60 * 1000;
const MAX_REASON_COUNT = 5;
const MAX_SPAN_PREVIEW_COUNT = 5;

interface Args {
  episodeId?: number;
  transcriptFile?: string;
  outputFile?: string;
  models: string[];
}

interface EpisodeTranscriptLookup {
  transcriptKey: string;
}

interface TranscriptSource {
  transcript: TranscriptResult;
  transcriptKey?: string;
  transcriptFile: string;
  cleanup: () => Promise<void>;
}

interface ModelSummary {
  model: string;
  status: "ok" | "error";
  requestDurationMs?: number;
  estimatedCostUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  spanCount?: number;
  openingSpanCount?: number;
  earliestSpanStartMs?: number | null;
  removedDurationMs?: number;
  reasons?: string[];
  spans?: AdSpan[];
  error?: string;
}

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(currentFile), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const apiWranglerConfigPath = resolve(workspaceRoot, "workers/api/wrangler.jsonc");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    models: [...DEFAULT_MODELS]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "--episode-id":
        args.episodeId = next ? Number.parseInt(next, 10) : NaN;
        index += 1;
        break;
      case "--transcript-file":
        args.transcriptFile = next;
        index += 1;
        break;
      case "--output-file":
        args.outputFile = next;
        index += 1;
        break;
      case "--models":
        args.models = next ? next.split(",").map((value) => value.trim()).filter((value) => value.length > 0) : [];
        index += 1;
        break;
      default:
        break;
    }
  }

  return args;
}

function extractJsonFromWranglerOutput(stdout: string): unknown {
  const firstBrace = stdout.search(/[\[{]/);
  if (firstBrace === -1) {
    throw new Error("Wrangler did not return JSON output.");
  }

  return JSON.parse(stdout.slice(firstBrace)) as unknown;
}

async function runWrangler(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("wrangler", args, {
    cwd: workspaceRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });

  return `${stdout}${stderr}`.trim();
}

async function getTranscriptKeyForEpisode(episodeId: number): Promise<string> {
  const output = await runWrangler([
    "d1",
    "execute",
    "podads",
    "--remote",
    "--config",
    apiWranglerConfigPath,
    "--command",
    `SELECT transcript_key AS transcriptKey FROM episodes WHERE id = ${episodeId} LIMIT 1;`
  ]);
  const parsed = extractJsonFromWranglerOutput(output) as Array<{ results?: EpisodeTranscriptLookup[] }>;
  const transcriptKey = parsed[0]?.results?.[0]?.transcriptKey;

  if (!transcriptKey) {
    throw new Error(`Episode ${episodeId} did not have a transcript_key in D1.`);
  }

  return transcriptKey;
}

async function downloadTranscriptArtifact(transcriptKey: string): Promise<TranscriptSource> {
  const tempDir = await mkdtemp(join(tmpdir(), "podads-transcript-"));
  const transcriptFile = join(tempDir, "transcript.json");
  await runWrangler([
    "r2",
    "object",
    "get",
    `podads-audio/${transcriptKey}`,
    "--remote",
    "--file",
    transcriptFile
  ]);

  const transcript = JSON.parse(await readFile(transcriptFile, "utf8")) as TranscriptResult;
  return {
    transcript,
    transcriptKey,
    transcriptFile,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function loadTranscriptFromFile(transcriptFile: string): Promise<TranscriptSource> {
  const transcript = JSON.parse(await readFile(transcriptFile, "utf8")) as TranscriptResult;
  return {
    transcript,
    transcriptFile,
    cleanup: async () => {}
  };
}

function mergeRanges(spans: AdSpan[]): AdSpan[] {
  if (spans.length === 0) {
    return [];
  }

  const sorted = [...spans].sort((left, right) => left.startMs - right.startMs);
  const merged: AdSpan[] = [{ ...sorted[0]! }];

  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...span });
      continue;
    }

    if (span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
      last.confidence = Math.max(last.confidence, span.confidence);
      last.reason = `${last.reason} | ${span.reason}`;
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

function summarizeRemovedDurationMs(spans: AdSpan[]): number {
  return mergeRanges(spans).reduce((sum, span) => sum + (span.endMs - span.startMs), 0);
}

function summarizeModelResult(
  model: string,
  result: Awaited<ReturnType<typeof runOpenRouterClassificationModel>>
): ModelSummary {
  return {
    model,
    status: "ok",
    requestDurationMs: result.requestDurationMs,
    estimatedCostUsd: result.estimatedCostUsd,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    spanCount: result.spans.length,
    openingSpanCount: result.spans.filter((span) => span.startMs < OPENING_WINDOW_MS).length,
    earliestSpanStartMs: result.spans.length > 0 ? Math.min(...result.spans.map((span) => span.startMs)) : null,
    removedDurationMs: summarizeRemovedDurationMs(result.spans),
    reasons: result.spans.slice(0, MAX_REASON_COUNT).map((span) => span.reason),
    spans: result.spans.slice(0, MAX_SPAN_PREVIEW_COUNT)
  };
}

function buildEnv(): Env {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY in the local environment.");
  }

  return {
    OPENROUTER_API_KEY: openRouterApiKey,
    APP_BASE_URL: "http://localhost:8787"
  } as Env;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run src/compareAdModels.ts --episode-id 4475",
    "  bun run src/compareAdModels.ts --transcript-file /tmp/transcript.json",
    "",
    "Optional flags:",
    "  --models google/gemini-3.1-flash-lite-preview,google/gemini-3-flash-preview,openai/gpt-5.4,qwen/qwen3.6-plus",
    "  --output-file /tmp/podads-model-compare.json"
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const source =
    args.transcriptFile
      ? await loadTranscriptFromFile(resolve(process.cwd(), args.transcriptFile))
      : Number.isFinite(args.episodeId)
        ? await downloadTranscriptArtifact(await getTranscriptKeyForEpisode(args.episodeId!))
        : null;

  if (!source) {
    throw new Error(usage());
  }

  const env = buildEnv();
  const transcript = source.transcript;

  try {
    const settled = await Promise.allSettled(
      args.models.map(async (model) => ({
        model,
        result: await runOpenRouterClassificationModel(env, model, transcript, {
          mentionPrerolls: true
        })
      }))
    );

    const summaries: ModelSummary[] = settled.map((entry, index) => {
      const model = args.models[index] ?? `model-${index + 1}`;
      if (entry.status === "fulfilled") {
        return summarizeModelResult(entry.value.model, entry.value.result);
      }

      return {
        model,
        status: "error",
        error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      };
    });

    const output = {
      episodeId: args.episodeId ?? null,
      transcriptKey: source.transcriptKey ?? null,
      transcriptFile: source.transcriptFile,
      transcript: {
        provider: transcript.provider,
        model: transcript.model,
        segmentCount: transcript.segments.length,
        analyzedDurationMs: transcript.analyzedDurationMs,
        analysisTruncated: transcript.analysisTruncated,
        openingPreview: transcript.segments.slice(0, 6)
      },
      models: summaries
    };
    const outputFile = args.outputFile
      ? resolve(process.cwd(), args.outputFile)
      : join(tmpdir(), `podads-model-compare-${args.episodeId ?? "transcript"}.json`);

    await writeFile(outputFile, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output, null, 2));
    console.log(`\nSaved comparison output to ${outputFile}`);
  } finally {
    await source.cleanup();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
