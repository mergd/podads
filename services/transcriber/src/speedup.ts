import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function speedUpAudio(inputPath: string, multiplier: number): Promise<string> {
  if (multiplier <= 1) return inputPath;

  const outputPath = join(tmpdir(), `speedup-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-filter:a", `atempo=${multiplier}`,
    "-q:a", "4",
    "-ac", "1",
    outputPath,
  ], { timeout: 120_000 });

  return outputPath;
}

export async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
