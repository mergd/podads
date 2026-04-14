import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { TRANSCRIPTION_AUDIO_BITRATE, TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ } from "./speedup.js";

const execFileAsync = promisify(execFile);

const MAX_CHUNK_BYTES = 24 * 1024 * 1024; // 24MB — stay under Groq's 25MB limit
const CHUNK_DURATION_SECONDS = 600; // 10 min per chunk as starting point

interface ChunkInfo {
  path: string;
  /** Offset in seconds from the start of the original audio */
  offsetSeconds: number;
}

async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ], { timeout: 30_000 });

  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration for ${filePath}`);
  }
  return duration;
}

export async function splitAudioIntoChunks(filePath: string): Promise<ChunkInfo[]> {
  const fileSize = (await stat(filePath)).size;

  if (fileSize <= MAX_CHUNK_BYTES) {
    return [{ path: filePath, offsetSeconds: 0 }];
  }

  const totalDuration = await getAudioDuration(filePath);
  const estimatedChunks = Math.ceil(fileSize / MAX_CHUNK_BYTES);
  const chunkDuration = Math.min(
    CHUNK_DURATION_SECONDS,
    Math.floor(totalDuration / estimatedChunks)
  );

  const chunks: ChunkInfo[] = [];

  for (let offset = 0; offset < totalDuration; offset += chunkDuration) {
    const chunkPath = join(
      tmpdir(),
      `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`
    );

    await execFileAsync("ffmpeg", [
      "-y",
      "-ss", String(offset),
      "-t", String(chunkDuration),
      "-i", filePath,
      "-ar", String(TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ),
      "-ac", "1",
      "-b:a", TRANSCRIPTION_AUDIO_BITRATE,
      chunkPath,
    ], { timeout: 60_000 });

    chunks.push({ path: chunkPath, offsetSeconds: offset });
  }

  return chunks;
}
