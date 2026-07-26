import { execFile, type ExecFileException } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ = 16_000;
const DEFAULT_TRANSCRIPTION_AUDIO_BITRATE = "16k";
// basic CF containers (~1/4 vCPU) encode ~20-25x realtime; a 2h analysis
// window at 2x speedup still needs ~2-3 minutes of wall clock.
const PREPARE_TIMEOUT_MS = 300_000;

export const TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ = Number(process.env.TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ)
  || DEFAULT_TRANSCRIPTION_AUDIO_SAMPLE_RATE_HZ;
export const TRANSCRIPTION_AUDIO_BITRATE = process.env.TRANSCRIPTION_AUDIO_BITRATE ?? DEFAULT_TRANSCRIPTION_AUDIO_BITRATE;

export class AudioPrepareTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Audio prepare timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "AudioPrepareTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function getFileSizeBytes(path: string): Promise<number> {
  return (await stat(path)).size;
}

function stderrText(error: ExecFileException): string {
  if (typeof error.stderr === "string") {
    return error.stderr;
  }

  if (error.stderr != null) {
    return Buffer.from(error.stderr as Uint8Array).toString("utf8");
  }

  return "";
}

function summarizeFfmpegFailure(error: ExecFileException): string {
  const meaningful = stderrText(error)
    .split(/\r?\n/)
    .map((line: string) => line.replace(/\r/g, "").trim())
    .filter((line: string) => line.length > 0)
    .filter((line: string) => !/^size=\s*\d/i.test(line))
    .filter((line: string) => !/^ffmpeg version/i.test(line))
    .filter((line: string) => !/^built with/i.test(line))
    .filter((line: string) => !/^configuration:/i.test(line))
    .filter((line: string) => !/^lib(av|sw)/i.test(line))
    .slice(-8);

  if (meaningful.length > 0) {
    return meaningful.join(" | ");
  }

  return error.message;
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

  try {
    await execFileAsync("ffmpeg", ffmpegArgs, { timeout: PREPARE_TIMEOUT_MS });
  } catch (error) {
    const execError = error as ExecFileException;
    if (execError.killed || execError.signal === "SIGTERM") {
      throw new AudioPrepareTimeoutError(PREPARE_TIMEOUT_MS);
    }

    throw new Error(`Audio prepare failed: ${summarizeFfmpegFailure(execError)}`);
  }

  return outputPath;
}

export async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
