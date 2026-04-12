import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import Fastify from "fastify";
import multipart from "@fastify/multipart";

import { transcribeWithGroq, type TranscriptionResult } from "./groq.js";
import { cleanupFile, speedUpAudio } from "./speedup.js";

const PORT = Number(process.env.PORT) || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";
const GATEWAY_TOKEN = process.env.TRANSCRIPTION_GATEWAY_TOKEN ?? "";
const SPEED_MULTIPLIER = Number(process.env.SPEED_MULTIPLIER) || 2;

const app = Fastify({ logger: true, bodyLimit: 200 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

app.get("/health", async () => ({
  status: "ok",
  speed_multiplier: SPEED_MULTIPLIER,
  groq_configured: GROQ_API_KEY.length > 0,
  gateway_auth_enabled: GATEWAY_TOKEN.length > 0,
}));

function isAuthorized(authHeader: string | undefined): boolean {
  if (!GATEWAY_TOKEN) {
    return true;
  }

  return authHeader === `Bearer ${GATEWAY_TOKEN}`;
}

async function downloadToTmp(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "PodAds/1.0" } });
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

    if (!GROQ_API_KEY) {
      return reply.status(500).send({ error: "GROQ_API_KEY is not configured" });
    }

    const result: TranscriptionResult = await transcribeWithGroq(
      speedAudioPath,
      GROQ_API_KEY,
      SPEED_MULTIPLIER,
    );

    const elapsed = (Date.now() - start) / 1000;

    return {
      text: result.text,
      segments: result.segments,
      duration: result.duration,
      language: "en",
      x_podads: {
        provider: result.provider,
        model: "whisper-large-v3-turbo",
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
