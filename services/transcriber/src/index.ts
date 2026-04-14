import Fastify from "fastify";
import multipart from "@fastify/multipart";

import { buildRewriteResponseHeaders, rewriteAudioFromUrl, type RewriteSpan } from "./rewrite.js";
import { sendMistralCapacityAlert } from "./alerts.js";
import { downloadToTmp, saveUploadToTmp } from "./downloads.js";
import {
  createGroqKeyPool,
  GroqRateLimitError,
  parseGroqKeyConfigs,
  transcribeWithGroq,
  type TranscriptionResult
} from "./groq.js";
import { MistralRetryableError, transcribeWithMistral } from "./mistral.js";
import { cleanupFile, getFileSizeBytes, prepareAudioForTranscription } from "./speedup.js";

const PORT = Number(process.env.PORT) || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_API_KEYS = process.env.GROQ_API_KEYS ?? "";
const GATEWAY_TOKEN = process.env.TRANSCRIPTION_GATEWAY_TOKEN ?? "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL ?? "voxtral-mini-latest";
const SPEED_MULTIPLIER = Number(process.env.SPEED_MULTIPLIER) || 2;
const groqKeys = parseGroqKeyConfigs(GROQ_API_KEYS, GROQ_API_KEY);
const groqKeyPool = createGroqKeyPool(groqKeys);

const app = Fastify({ logger: true, bodyLimit: 200 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

app.get("/health", async () => ({
  status: "ok",
  transcription_provider: "groq-with-mistral-fallback",
  speed_multiplier: SPEED_MULTIPLIER,
  groq_configured: groqKeys.length > 0,
  groq_key_count: groqKeys.length,
  mistral_configured: MISTRAL_API_KEY.length > 0,
  mistral_model: MISTRAL_MODEL,
  gateway_auth_enabled: GATEWAY_TOKEN.length > 0,
}));

function isAuthorized(authHeader: string | undefined): boolean {
  if (!GATEWAY_TOKEN) {
    return true;
  }

  return authHeader === `Bearer ${GATEWAY_TOKEN}`;
}

interface TranscribeBody {
  analysis_window_ms?: number;
  url?: string;
}

interface RewriteBody {
  url?: string;
  source_content_type?: string | null;
  ad_spans?: Array<{
    start_ms?: number;
    end_ms?: number;
  }>;
}

function normalizeAnalysisWindowMs(value: number | undefined): number | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizeRewriteSpans(value: RewriteBody["ad_spans"]): RewriteSpan[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((span) => {
    if (!span || typeof span !== "object") {
      return [];
    }

    const startMs = span.start_ms;
    const endMs = span.end_ms;

    if (
      typeof startMs !== "number"
      || typeof endMs !== "number"
      || !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || endMs <= startMs
    ) {
      return [];
    }

    return [{ startMs: Math.max(0, Math.round(startMs)), endMs: Math.max(0, Math.round(endMs)) }];
  });
}

function truncateTranscriptionResult(
  result: TranscriptionResult,
  analysisWindowMs: number | null
): { result: TranscriptionResult; analysisTruncated: boolean } {
  if (analysisWindowMs === null) {
    return {
      result,
      analysisTruncated: false
    };
  }

  const analysisWindowSeconds = analysisWindowMs / 1000;
  const analysisTruncated = result.segments.some((segment) => (segment.end * 1000) > analysisWindowMs);
  const segments = result.segments
    .filter((segment) => (segment.start * 1000) < analysisWindowMs)
    .map((segment) => ({
      ...segment,
      end: Math.min(segment.end, analysisWindowSeconds)
    }))
    .filter((segment) => segment.end > segment.start);

  return {
    result: {
      ...result,
      text: segments.map((segment) => segment.text).join(" ").trim(),
      segments,
      duration: segments.length === 0 ? 0 : (segments[segments.length - 1]?.end ?? 0)
    },
    analysisTruncated
  };
}

app.post<{ Body: TranscribeBody }>("/v1/audio/transcriptions", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const start = Date.now();
  const filesToCleanup: string[] = [];
  let downloadMs: number | undefined;
  let prepareMs: number | undefined;
  let analysisWindowMs: number | null = null;
  let sourceInputBytes: number | undefined;
  let preparedInputBytes: number | undefined;

  try {
    let rawAudioPath: string;

    const contentType = request.headers["content-type"] ?? "";
    if (contentType.includes("multipart")) {
      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "No file uploaded" });
      const chunks: Buffer[] = [];
      for await (const chunk of file.file) chunks.push(chunk);
      rawAudioPath = await saveUploadToTmp(Buffer.concat(chunks));
    } else {
      const body = request.body as TranscribeBody;
      if (!body.url) return reply.status(400).send({ error: "Provide a file upload or JSON body with 'url'" });
      analysisWindowMs = normalizeAnalysisWindowMs(body.analysis_window_ms);
      const downloadStart = Date.now();
      rawAudioPath = await downloadToTmp(body.url);
      downloadMs = Date.now() - downloadStart;
    }
    filesToCleanup.push(rawAudioPath);
    sourceInputBytes = await getFileSizeBytes(rawAudioPath);

    const prepareStart = Date.now();
    const preparedAudioPath = await prepareAudioForTranscription(rawAudioPath, SPEED_MULTIPLIER, analysisWindowMs);
    prepareMs = Date.now() - prepareStart;
    if (preparedAudioPath !== rawAudioPath) {
      filesToCleanup.push(preparedAudioPath);
    }
    preparedInputBytes = await getFileSizeBytes(preparedAudioPath);

    let result: TranscriptionResult;

    try {
      if (groqKeyPool.size > 0) {
        try {
          result = await transcribeWithGroq(
            preparedAudioPath,
            groqKeyPool,
            SPEED_MULTIPLIER,
          );
        } catch (error) {
          if (!(error instanceof GroqRateLimitError) || error.scope !== "all-keys") {
            throw error;
          }

          const retryAfterSeconds = error.retryAfterSeconds ?? 60;
          if (!MISTRAL_API_KEY) {
            reply.header("Retry-After", String(retryAfterSeconds));
            return reply.status(429).send({
              error: error.message,
              retry_after_seconds: retryAfterSeconds
            });
          }

          result = await transcribeWithMistral(
            preparedAudioPath,
            MISTRAL_API_KEY,
            MISTRAL_MODEL,
            SPEED_MULTIPLIER
          );
        }
      } else if (MISTRAL_API_KEY) {
        result = await transcribeWithMistral(
          preparedAudioPath,
          MISTRAL_API_KEY,
          MISTRAL_MODEL,
          SPEED_MULTIPLIER
        );
      } else {
        return reply.status(500).send({ error: "No transcription providers are configured" });
      }
    } catch (error) {
      if (error instanceof GroqRateLimitError) {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;
        reply.header("Retry-After", String(retryAfterSeconds));
        return reply.status(429).send({
          error: error.message,
          retry_after_seconds: retryAfterSeconds
        });
      }

      if (error instanceof MistralRetryableError) {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;

        if (error.statusCode === 429) {
          await sendMistralCapacityAlert({
            model: MISTRAL_MODEL,
            retryAfterSeconds,
            errorMessage: error.message
          });
        }

        reply.header("Retry-After", String(retryAfterSeconds));
        return reply.status(429).send({
          error: error.message,
          retry_after_seconds: retryAfterSeconds
        });
      }

      throw error;
    }

    const truncated = truncateTranscriptionResult(result, analysisWindowMs);
    result = truncated.result;
    const elapsed = (Date.now() - start) / 1000;

    return {
      text: result.text,
      segments: result.segments,
      duration: result.duration,
      language: "en",
      x_podads: {
        provider: result.provider,
        model: result.model,
        estimated_cost_usd: result.estimatedCostUsd,
        speed_multiplier: SPEED_MULTIPLIER,
        download_ms: downloadMs,
        prepare_ms: prepareMs,
        source_input_bytes: sourceInputBytes,
        prepared_input_bytes: preparedInputBytes,
        analysis_window_ms: analysisWindowMs,
        analysis_truncated: truncated.analysisTruncated,
        transcribe_seconds: Math.round(elapsed * 100) / 100,
        realtime_factor: elapsed > 0 ? Math.round((result.duration / elapsed) * 10) / 10 : 0,
      },
    };
  } finally {
    await Promise.all(filesToCleanup.map(cleanupFile));
  }
});

app.post<{ Body: RewriteBody }>("/v1/audio/rewrite", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const body = request.body as RewriteBody;
  const url = typeof body.url === "string" ? body.url : null;
  const adSpans = normalizeRewriteSpans(body.ad_spans);

  if (!url || adSpans === null) {
    return reply.status(400).send({ error: "Provide a JSON body with 'url' and valid 'ad_spans'" });
  }

  const result = await rewriteAudioFromUrl({
    url,
    sourceContentType: typeof body.source_content_type === "string" ? body.source_content_type : null,
    adSpans
  });
  const responseHeaders = buildRewriteResponseHeaders(result);

  for (const [headerName, headerValue] of Object.entries(responseHeaders)) {
    reply.header(headerName, headerValue);
  }

  reply.type(result.contentType);
  return reply.send(Buffer.from(result.bytes));
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Transcriber listening on :${PORT}`);
