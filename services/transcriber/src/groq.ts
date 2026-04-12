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

async function transcribeChunk(
  audioPath: string,
  apiKey: string,
): Promise<{ segments: GroqSegment[]; duration: number }> {
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
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as GroqResponse;
  return {
    segments: payload.segments ?? [],
    duration: payload.duration ?? 0,
  };
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
  apiKey: string,
  speedMultiplier: number,
): Promise<TranscriptionResult> {
  const chunks = await splitAudioIntoChunks(audioPath);
  const isChunked = chunks.length > 1;
  const chunkCleanup = isChunked ? chunks.map((c) => c.path) : [];

  try {
    const chunkResults = await runWithConcurrency(
      chunks,
      GROQ_CONCURRENCY,
      (chunk) => transcribeChunk(chunk.path, apiKey),
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
