import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DOWNLOAD_TIMEOUT_MS = 180_000;

export async function downloadToTmp(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "PodAds/1.0" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }

  const tmpPath = join(tmpdir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const destination = createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(response.body as never), destination);
  return tmpPath;
}

export async function saveUploadToTmp(data: Buffer): Promise<string> {
  const tmpPath = join(tmpdir(), `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  await writeFile(tmpPath, data);
  return tmpPath;
}
