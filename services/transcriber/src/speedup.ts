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

export class AudioPrepareError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | number | null;
  readonly lastOutputTime: string | null;
  readonly summary: string;

  constructor(input: {
    exitCode: number | null;
    signal: NodeJS.Signals | number | null;
    lastOutputTime: string | null;
    summary: string;
  }) {
    super(`Audio prepare failed: ${input.summary}`);
    this.name = "AudioPrepareError";
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.lastOutputTime = input.lastOutputTime;
    this.summary = input.summary;
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

function extractLastOutputTime(text: string): string | null {
  const matches = [...text.matchAll(/\btime=(\d{2}:\d{2}:\d{2}\.\d+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function summarizeFfmpegFailure(error: ExecFileException): string {
  const stderr = stderrText(error);
  const lastOutputTime = extractLastOutputTime(stderr);
  const meaningful = stderr
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .filter((line: string) => !/^size=\s*\d/i.test(line))
    .filter((line: string) => !/^ffmpeg version/i.test(line))
    .filter((line: string) => !/^built with/i.test(line))
    .filter((line: string) => !/^configuration:/i.test(line))
    .filter((line: string) => !/^lib(av|sw)/i.test(line))
    .filter((line: string) => !/^(?:lyrics-|title\s*:|album\s*:|genre\s*:|date\s*:)/i.test(line))
    .filter((line: string) => !/^:?\s*</.test(line) && !/<\/(?:p|a|br)>/i.test(line))
    .filter((line: string) => /error|failed|invalid|cannot|unable|no such|permission|conversion|disk|killed|timeout/i.test(line))
    .slice(-4);

  const parts: string[] = [];
  if (typeof error.code === "number") {
    parts.push(`ffmpeg exit ${error.code}`);
  } else if (error.signal) {
    parts.push(`ffmpeg signal ${error.signal}`);
  }

  if (lastOutputTime) {
    parts.push(`last output time ${lastOutputTime}`);
  }

  if (meaningful.length > 0) {
    parts.push(meaningful.join(" | "));
  } else {
    parts.push("no ffmpeg error line; encode likely failed while writing the output file");
  }

  return parts.join(". ");
}

export async function prepareAudioForTranscription(
  inputPath: string,
  multiplier: number,
  analysisWindowMs: number | null,
  startOffsetMs = 0
): Promise<string> {
  const outputPath = join(tmpdir(), `prepared-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const ffmpegArgs = [
    "-y",
    "-hide_banner",
  ];

  if (startOffsetMs > 0) {
    ffmpegArgs.push("-ss", String(startOffsetMs / 1000));
  }

  if (analysisWindowMs !== null) {
    ffmpegArgs.push("-t", String(analysisWindowMs / 1000));
  }

  ffmpegArgs.push(
    "-i", inputPath,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-vn",
    "-sn",
    "-dn",
  );

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

    throw new AudioPrepareError({
      exitCode: typeof execError.code === "number" ? execError.code : null,
      signal: execError.signal ?? null,
      lastOutputTime: extractLastOutputTime(stderrText(execError)),
      summary: summarizeFfmpegFailure(execError)
    });
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
