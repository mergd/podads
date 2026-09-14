import { describe, expect, test } from "bun:test";

import {
  CHUNK_DURATION_SECONDS,
  MAX_CHUNK_BYTES,
  chunkStartOffsets,
  resolveChunkDurationSeconds
} from "./chunk";

describe("resolveChunkDurationSeconds", () => {
  test("leaves short files under the Groq size cap unsplit", () => {
    expect(resolveChunkDurationSeconds(599, 3 * 1024 * 1024)).toBeNull();
    expect(resolveChunkDurationSeconds(CHUNK_DURATION_SECONDS, MAX_CHUNK_BYTES)).toBeNull();
  });

  test("pages 10 minutes even when the file is well under 24MB", () => {
    const goolsbeePreparedBytes = 3_316_472;
    const goolsbeePreparedSeconds = 1_658;

    expect(resolveChunkDurationSeconds(goolsbeePreparedSeconds, goolsbeePreparedBytes)).toBe(
      CHUNK_DURATION_SECONDS
    );
  });

  test("shortens pages if a 10 minute slice would exceed 24MB", () => {
    const tenMinuteBytes = MAX_CHUNK_BYTES * 2;
    expect(resolveChunkDurationSeconds(CHUNK_DURATION_SECONDS, tenMinuteBytes)).toBe(
      Math.floor(MAX_CHUNK_BYTES / (tenMinuteBytes / CHUNK_DURATION_SECONDS))
    );
  });
});

describe("chunkStartOffsets", () => {
  test("does not create a trailing chunk shorter than the provider minimum", () => {
    expect(chunkStartOffsets(600.005, 600)).toEqual([0]);
  });

  test("keeps a substantive final chunk for a long episode", () => {
    expect(chunkStartOffsets(6451, 600).at(-1)).toBe(6000);
  });
});
