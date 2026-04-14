import { execFile } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_TRANSCRIPTION_AUDIO_BITRATE = "16k";

export const TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ = Number(process.env.TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ)
  || DEFAULT_TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ;
export const TRANSCRIPTION_AUDIO_BITRATE = process.env.TRANSCRIPTION_AUDIO_BITRATE ?? DEFAULT_TRANSCRIPTION_AUDIO_BITRATE;

export async function getFileSizeBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function prepareAudioForTranscription(
  inputPath: string,
  multiplier: number,
  analysisWindowMs: number | null
): Promise<string> {
  const outputPath = join(tmpdir(), `prepared-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const ffmpegArgs = [
    "-y",
    "-i", inputPath,
    "-vn",
  ];

  if (analysisWindowMs !== null) {
    ffmpegArgs.push("-t", String(analysisWindowMs / 1000));
  }

  if (multiplier > 1) {
    ffmpegArgs.push("-filter:a", `atempo=${multiplier}`);
  }

  ffmpegArgs.push(
    "-ar", String(TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ),
    "-ac", "1",
    "-b:a", TRANSCRIPTION_AUDIO_BITRATE,
    outputPath,
  );

  await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 120_000 });

  return outputPath;
}

export async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
