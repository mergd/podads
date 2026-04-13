import type { EpisodeRecord, TranscriptResult, TranscriptSegment } from "../../lib/types";
import { RetryableProcessingError } from "../../lib/retryable";

interface GatewaySegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface GatewayResponse {
  text: string;
  segments: GatewaySegment[];
  duration: number;
  x_podads?: {
    analysis_truncated?: boolean;
    analysis_window_ms?: number;
    provider?: string;
    model?: string;
    estimated_cost_usd?: number | null;
    speed_multiplier?: number;
    download_ms?: number;
    prepare_ms?: number;
    source_input_bytes?: number;
    prepared_input_bytes?: number;
    transcribe_seconds?: number;
    realtime_factor?: number;
  };
}

function toSegments(raw: GatewaySegment[]): TranscriptSegment[] {
  return raw
    .filter((s) => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string")
    .map((s) => ({
      startMs: Math.max(0, Math.round(s.start * 1000)),
      endMs: Math.max(0, Math.round(s.end * 1000)),
      text: s.text.trim()
    }))
    .filter((s) => s.text.length > 0 && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

function sumDefinedNumbers(...values: Array<number | undefined>): number | undefined {
  const definedValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (definedValues.length === 0) {
    return undefined;
  }

  return definedValues.reduce((sum, value) => sum + value, 0);
}

const GATEWAY_TIMEOUT_MS = 290_000;
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504, 524]);

function parseRetryAfterSeconds(headerValue: string | null, body: string): number | undefined {
  if (headerValue) {
    const numeric = Number.parseInt(headerValue, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const dateMs = Date.parse(headerValue);
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

async function fetchGateway(
  url: string,
  gatewayToken: string | undefined,
  body: string
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {})
        },
        body,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
      });

      if (response.ok) {
        return response;
      }

      const text = await response.text();

      if (response.status === 429) {
        throw new RetryableProcessingError(
          `Transcription gateway failed (${response.status}): ${text}`,
          parseRetryAfterSeconds(response.headers.get("retry-after"), text) ?? DEFAULT_RETRY_DELAY_SECONDS
        );
      }

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        throw new Error(`Transcription gateway failed (${response.status}): ${text}`);
      }

      lastError = new RetryableProcessingError(
        `Transcription gateway failed (${response.status}): ${text}`,
        DEFAULT_RETRY_DELAY_SECONDS * (attempt + 1)
      );
    } catch (error) {
      if (error instanceof RetryableProcessingError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes("Transcription gateway failed")) {
        throw error;
      }

      lastError = new RetryableProcessingError(
        error instanceof Error ? error.message : String(error),
        DEFAULT_RETRY_DELAY_SECONDS * (attempt + 1)
      );
    }
  }

  throw lastError ?? new RetryableProcessingError("Transcription gateway failed after retries", DEFAULT_RETRY_DELAY_SECONDS);
}

export async function gatewayTranscription(
  env: Env,
  episode: EpisodeRecord,
  analysisWindowMs?: number
): Promise<TranscriptResult> {
  const baseUrl = env.TRANSCRIPTION_GATEWAY_URL;
  if (!baseUrl) {
    throw new Error("Missing TRANSCRIPTION_GATEWAY_URL configuration.");
  }
  const gatewayToken = env.TRANSCRIPTION_GATEWAY_TOKEN;

  const t0 = Date.now();
  const response = await fetchGateway(
    `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    gatewayToken,
    JSON.stringify({
      url: episode.source_enclosure_url,
      analysis_window_ms: analysisWindowMs
    })
  );

  const payload = (await response.json()) as GatewayResponse;
  const requestDurationMs = Date.now() - t0;

  const segments = toSegments(payload.segments ?? []);
  const text = payload.text?.trim() || segments.map((s) => s.text).join(" ").trim();

  if (!text) {
    throw new Error("Transcription gateway returned empty text.");
  }

  const meta = payload.x_podads;
  const boundedAnalysisWindowMs =
    typeof meta?.analysis_window_ms === "number" && Number.isFinite(meta.analysis_window_ms) && meta.analysis_window_ms > 0
      ? Math.round(meta.analysis_window_ms)
      : null;

  return {
    provider: meta?.provider ?? "gateway",
    model: meta?.model ?? "unknown",
    text,
    segments,
    estimatedCostUsd: meta?.estimated_cost_usd ?? 0,
    analysisWindowMs: boundedAnalysisWindowMs,
    analyzedDurationMs: segments.length === 0 ? 0 : (segments[segments.length - 1]?.endMs ?? 0),
    analysisTruncated: Boolean(meta?.analysis_truncated),
    inputBytes: meta?.prepared_input_bytes,
    requestDurationMs,
    providerQueueDelayMs: sumDefinedNumbers(meta?.download_ms, meta?.prepare_ms),
    providerExecutionMs: meta?.transcribe_seconds ? Math.round(meta.transcribe_seconds * 1000) : undefined
  };
}
