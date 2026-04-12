import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { splitAudioIntoChunks } from "./chunk.js";
import { cleanupFile } from "./speedup.js";

interface GroqSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface GroqResponse {
  text: string;
  segments: GroqSegment[];
  duration?: number;
}

export interface TranscriptionResult {
  text: string;
  segments: { id: number; start: number; end: number; text: string }[];
  duration: number;
  provider: "groq" | "local";
  estimatedCostUsd: number | null;
}

const GROQ_CONCURRENCY = 3;
const GROQ_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface GroqKeyConfig {
  apiKey: string;
  label: string;
}

interface GroqKeyState extends GroqKeyConfig {
  cooldownUntil: number;
  inFlight: number;
}

export interface GroqKeyPool {
  size: number;
  withKey<T>(operation: (config: GroqKeyConfig) => Promise<T>): Promise<T>;
}

export class GroqRateLimitError extends Error {
  retryAfterSeconds?: number;
  scope: "single-key" | "all-keys";

  constructor(message: string, retryAfterSeconds: number | undefined, scope: "single-key" | "all-keys") {
    super(message);
    this.name = "GroqRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
}

function parseRetryAfterSeconds(retryAfterHeader: string | null, body: string): number | undefined {
  if (retryAfterHeader) {
    const numeric = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const dateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(dateMs)) {
      const delaySeconds = Math.ceil((dateMs - Date.now()) / 1000);
      if (delaySeconds > 0) {
        return delaySeconds;
      }
    }
  }

  const durationMatch = body.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!durationMatch) {
    return undefined;
  }

  const hours = Number.parseInt(durationMatch[1] ?? "0", 10) || 0;
  const minutes = Number.parseInt(durationMatch[2] ?? "0", 10) || 0;
  const seconds = Number.parseInt(durationMatch[3] ?? "0", 10) || 0;
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

  return totalSeconds > 0 ? totalSeconds : undefined;
}

export function parseGroqKeyConfigs(rawKeys: string, legacyKey: string): GroqKeyConfig[] {
  const values = [rawKeys, legacyKey]
    .flatMap((value) => value.split(/\r?\n|,/))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith("#"));

  const uniqueKeys = new Set<string>();
  const configs: GroqKeyConfig[] = [];

  for (const value of values) {
    if (uniqueKeys.has(value)) {
      continue;
    }

    uniqueKeys.add(value);
    configs.push({
      apiKey: value,
      label: `groq-${configs.length + 1}`
    });
  }

  return configs;
}

export function createGroqKeyPool(configs: GroqKeyConfig[]): GroqKeyPool {
  const states: GroqKeyState[] = configs.map((config) => ({
    ...config,
    cooldownUntil: 0,
    inFlight: 0
  }));

  return {
    size: states.length,
    async withKey<T>(operation: (config: GroqKeyConfig) => Promise<T>): Promise<T> {
      if (states.length === 0) {
        throw new Error("GROQ_API_KEY or GROQ_API_KEYS is not configured");
      }

      const now = Date.now();
      const availableStates = states
        .filter((state) => state.cooldownUntil <= now)
        .sort((left, right) => {
          if (left.inFlight !== right.inFlight) {
            return left.inFlight - right.inFlight;
          }

          return left.label.localeCompare(right.label);
        });

      const selectedState = availableStates[0];

      if (!selectedState) {
        const nextCooldown = Math.min(...states.map((state) => state.cooldownUntil));
        const retryAfterSeconds = Math.max(1, Math.ceil((nextCooldown - now) / 1000));
        throw new GroqRateLimitError("All Groq orgs are temporarily cooling down.", retryAfterSeconds, "all-keys");
      }

      selectedState.inFlight += 1;

      try {
        return await operation(selectedState);
      } catch (error) {
        if (error instanceof GroqRateLimitError) {
          const retryAfterSeconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
          selectedState.cooldownUntil = Math.max(
            selectedState.cooldownUntil,
            Date.now() + (retryAfterSeconds * 1000)
          );
        }

        throw error;
      } finally {
        selectedState.inFlight = Math.max(0, selectedState.inFlight - 1);
      }
    }
  };
}

async function transcribeChunk(
  audioPath: string,
  keyPool: GroqKeyPool,
): Promise<{ segments: GroqSegment[]; duration: number }> {
  return keyPool.withKey(async ({ apiKey }) => {
    const audioData = await readFile(audioPath);
    const blob = new Blob([audioData], { type: "audio/mpeg" });

    const form = new FormData();
    form.append("file", blob, basename(audioPath));
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("language", "en");
    form.append("temperature", "0");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(GROQ_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const body = await response.text();

      if (response.status === 429) {
        throw new GroqRateLimitError(
          `Groq ${response.status}: ${body}`,
          parseRetryAfterSeconds(response.headers.get("retry-after"), body) ?? DEFAULT_RETRY_AFTER_SECONDS,
          "single-key"
        );
      }

      throw new Error(`Groq ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as GroqResponse;
    return {
      segments: payload.segments ?? [],
      duration: payload.duration ?? 0,
    };
  });
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function transcribeWithGroq(
  audioPath: string,
  keyPool: GroqKeyPool,
  speedMultiplier: number,
): Promise<TranscriptionResult> {
  const chunks = await splitAudioIntoChunks(audioPath);
  const isChunked = chunks.length > 1;
  const chunkCleanup = isChunked ? chunks.map((c) => c.path) : [];

  try {
    const chunkResults = await runWithConcurrency(
      chunks,
      GROQ_CONCURRENCY,
      (chunk) => transcribeChunk(chunk.path, keyPool),
    );

    let globalId = 0;
    const allSegments: { id: number; start: number; end: number; text: string }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const result = chunkResults[i]!;

      for (const s of result.segments) {
        const rawStart = s.start + chunk.offsetSeconds;
        const rawEnd = s.end + chunk.offsetSeconds;

        allSegments.push({
          id: globalId++,
          start: Math.round(rawStart * speedMultiplier * 100) / 100,
          end: Math.round(rawEnd * speedMultiplier * 100) / 100,
          text: s.text.trim(),
        });
      }
    }

    const duration = allSegments.length > 0 ? allSegments[allSegments.length - 1]!.end : 0;

    return {
      text: allSegments.map((s) => s.text).join(" "),
      segments: allSegments,
      duration,
      provider: "groq",
      estimatedCostUsd: duration > 0 ? (duration / speedMultiplier / 3600) * 0.04 : 0,
    };
  } finally {
    await Promise.all(chunkCleanup.map(cleanupFile));
  }
}
