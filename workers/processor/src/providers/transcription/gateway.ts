import type { EpisodeRecord, TranscriptResult, TranscriptSegment } from "../../lib/types";

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
    provider?: string;
    model?: string;
    estimated_cost_usd?: number | null;
    speed_multiplier?: number;
    download_ms?: number;
    speedup_ms?: number;
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

const GATEWAY_TIMEOUT_MS = 290_000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504, 524]);

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

      if (!RETRYABLE_STATUS_CODES.has(response.status)) {
        throw new Error(`Transcription gateway failed (${response.status}): ${text}`);
      }

      lastError = new Error(`Transcription gateway failed (${response.status}): ${text}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Transcription gateway failed")) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Transcription gateway failed after retries");
}

export async function gatewayTranscription(env: Env, episode: EpisodeRecord): Promise<TranscriptResult> {
  const baseUrl = env.TRANSCRIPTION_GATEWAY_URL;
  if (!baseUrl) {
    throw new Error("Missing TRANSCRIPTION_GATEWAY_URL configuration.");
  }
  const gatewayToken = env.TRANSCRIPTION_GATEWAY_TOKEN;

  const t0 = Date.now();
  const response = await fetchGateway(
    `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    gatewayToken,
    JSON.stringify({ url: episode.source_enclosure_url })
  );

  const payload = (await response.json()) as GatewayResponse;
  const requestDurationMs = Date.now() - t0;

  const segments = toSegments(payload.segments ?? []);
  const text = payload.text?.trim() || segments.map((s) => s.text).join(" ").trim();

  if (!text) {
    throw new Error("Transcription gateway returned empty text.");
  }

  const meta = payload.x_podads;

  return {
    provider: meta?.provider ?? "gateway",
    model: meta?.model ?? "unknown",
    text,
    segments,
    estimatedCostUsd: meta?.estimated_cost_usd ?? 0,
    analysisWindowMs: null,
    analyzedDurationMs: segments.length === 0 ? 0 : (segments[segments.length - 1]?.endMs ?? 0),
    analysisTruncated: false,
    requestDurationMs,
    providerQueueDelayMs:
      typeof meta?.download_ms === "number" && typeof meta?.speedup_ms === "number"
        ? meta.download_ms + meta.speedup_ms
        : typeof meta?.download_ms === "number"
          ? meta.download_ms
          : undefined,
    providerExecutionMs: meta?.transcribe_seconds ? Math.round(meta.transcribe_seconds * 1000) : undefined
  };
}
