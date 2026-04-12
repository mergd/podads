import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import Fastify from "fastify";
import multipart from "@fastify/multipart";

import { sendGroqCapacityAlert } from "./alerts.js";
import {
  createGroqKeyPool,
  GroqRateLimitError,
  parseGroqKeyConfigs,
  transcribeWithGroq,
  type TranscriptionResult
} from "./groq.js";
import { transcribeWithMistral } from "./mistral.js";
import { cleanupFile, speedUpAudio } from "./speedup.js";

const PORT = Number(process.env.PORT) || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GROQ_API_KEYS = process.env.GROQ_API_KEYS ?? "";
const GATEWAY_TOKEN = process.env.TRANSCRIPTION_GATEWAY_TOKEN ?? "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL ?? "voxtral-mini-latest";
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER ?? (MISTRAL_API_KEY ? "mistral" : "groq");
const SPEED_MULTIPLIER = Number(process.env.SPEED_MULTIPLIER) || 2;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const groqKeys = parseGroqKeyConfigs(GROQ_API_KEYS, GROQ_API_KEY);
const groqKeyPool = createGroqKeyPool(groqKeys);

const app = Fastify({ logger: true, bodyLimit: 200 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

function resolveConfiguredProvider(): "groq" | "mistral" {
  switch (TRANSCRIPTION_PROVIDER) {
    case "groq":
    case "mistral":
      return TRANSCRIPTION_PROVIDER;
    default:
      throw new Error(`Unsupported TRANSCRIPTION_PROVIDER: ${TRANSCRIPTION_PROVIDER}`);
  }
}

const configuredProvider = resolveConfiguredProvider();

app.get("/health", async () => ({
  status: "ok",
  transcription_provider: configuredProvider,
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

async function downloadToTmp(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "PodAds/1.0" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);

  const tmpPath = join(tmpdir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const dest = createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(res.body as never), dest);
  return tmpPath;
}

async function saveUploadToTmp(data: Buffer): Promise<string> {
  const tmpPath = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tmpPath, data);
  return tmpPath;
}

interface TranscribeBody {
  url?: string;
}

app.post<{ Body: TranscribeBody }>("/v1/audio/transcriptions", async (request, reply) => {
  if (!isAuthorized(request.headers.authorization)) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const start = Date.now();
  const filesToCleanup: string[] = [];
  let downloadMs: number | undefined;
  let speedupMs: number | undefined;

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
      const downloadStart = Date.now();
      rawAudioPath = await downloadToTmp(body.url);
      downloadMs = Date.now() - downloadStart;
    }
    filesToCleanup.push(rawAudioPath);

    const speedupStart = Date.now();
    const speedAudioPath = await speedUpAudio(rawAudioPath, SPEED_MULTIPLIER);
    speedupMs = Date.now() - speedupStart;
    if (speedAudioPath !== rawAudioPath) filesToCleanup.push(speedAudioPath);

    let result: TranscriptionResult;

    try {
      switch (configuredProvider) {
        case "groq":
          if (groqKeyPool.size === 0) {
            return reply.status(500).send({ error: "GROQ_API_KEY or GROQ_API_KEYS is not configured" });
          }

          result = await transcribeWithGroq(
            speedAudioPath,
            groqKeyPool,
            SPEED_MULTIPLIER,
          );
          break;
        case "mistral":
          result = await transcribeWithMistral(
            speedAudioPath,
            MISTRAL_API_KEY,
            MISTRAL_MODEL,
            SPEED_MULTIPLIER
          );
          break;
        default: {
          const exhaustiveCheck: never = configuredProvider;
          throw new Error(`Unhandled transcription provider: ${String(exhaustiveCheck)}`);
        }
      }
    } catch (error) {
      if (error instanceof GroqRateLimitError) {
        const retryAfterSeconds = error.retryAfterSeconds ?? 60;

        if (error.scope === "all-keys") {
          await sendGroqCapacityAlert({
            keyCount: groqKeyPool.size,
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
        speedup_ms: speedupMs,
        transcribe_seconds: Math.round(elapsed * 100) / 100,
        realtime_factor: elapsed > 0 ? Math.round((result.duration / elapsed) * 10) / 10 : 0,
      },
    };
  } finally {
    await Promise.all(filesToCleanup.map(cleanupFile));
  }
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Transcriber listening on :${PORT}`);
