import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { TranscriptionResult } from "./groq.js";

interface MistralSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface MistralUsage {
  prompt_audio_seconds?: number;
}

interface MistralResponse {
  text?: string;
  language?: string | null;
  model?: string;
  segments?: MistralSegment[];
  usage?: MistralUsage;
}

const MISTRAL_REQUEST_TIMEOUT_MS = 300_000;
const MISTRAL_STT_USD_PER_MINUTE = 0.003;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export class MistralRetryableError extends Error {
  retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "MistralRetryableError";
    this.retryAfterSeconds = retryAfterSeconds;
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

export async function transcribeWithMistral(
  audioPath: string,
  apiKey: string,
  model: string,
  speedMultiplier: number
): Promise<TranscriptionResult> {
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not configured");
  }

  const audioData = await readFile(audioPath);
  const blob = new Blob([audioData], { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, basename(audioPath));
  form.append("model", model);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("timestamp_granularities", "segment");

  const response = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form,
    signal: AbortSignal.timeout(MISTRAL_REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    const body = await response.text();

    if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
      throw new MistralRetryableError(
        `Mistral ${response.status}: ${body}`,
        parseRetryAfterSeconds(response.headers.get("retry-after"), body) ?? DEFAULT_RETRY_AFTER_SECONDS
      );
    }

    throw new Error(`Mistral ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as MistralResponse;
  const segments = (payload.segments ?? [])
    .filter((segment) => typeof segment.start === "number" && typeof segment.end === "number" && typeof segment.text === "string")
    .map((segment, index) => ({
      id: index,
      start: Math.round(segment.start! * speedMultiplier * 100) / 100,
      end: Math.round(segment.end! * speedMultiplier * 100) / 100,
      text: segment.text!.trim()
    }))
    .filter((segment) => segment.text.length > 0 && segment.end > segment.start);

  const text = typeof payload.text === "string" && payload.text.trim().length > 0
    ? payload.text.trim()
    : segments.map((segment) => segment.text).join(" ").trim();
  const duration = segments.length > 0 ? segments[segments.length - 1]!.end : 0;
  const promptAudioSeconds = payload.usage?.prompt_audio_seconds;
  const estimatedCostUsd = typeof promptAudioSeconds === "number" && Number.isFinite(promptAudioSeconds)
    ? (promptAudioSeconds / 60) * MISTRAL_STT_USD_PER_MINUTE
    : null;

  if (!text) {
    throw new Error("Mistral transcription returned empty text.");
  }

  return {
    text,
    segments,
    duration,
    provider: "mistral",
    model: payload.model ?? model,
    estimatedCostUsd
  };
}
