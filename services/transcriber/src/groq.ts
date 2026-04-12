import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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

export async function transcribeWithGroq(
  audioPath: string,
  apiKey: string,
  speedMultiplier: number,
): Promise<TranscriptionResult> {
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

  const segments = (payload.segments ?? []).map((s) => ({
    id: s.id,
    start: Math.round(s.start * speedMultiplier * 100) / 100,
    end: Math.round(s.end * speedMultiplier * 100) / 100,
    text: s.text.trim(),
  }));

  const duration = segments.length > 0 ? segments[segments.length - 1]!.end : 0;

  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    duration,
    provider: "groq",
    estimatedCostUsd: duration > 0 ? (duration / speedMultiplier / 3600) * 0.04 : 0,
  };
}
