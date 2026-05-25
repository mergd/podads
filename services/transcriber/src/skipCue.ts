import { readFileSync } from "node:fs";

import skipCueMp3 from "@podads/shared/assets/skip-cue.mp3";

let cachedSkipCueBytes: Uint8Array | null = null;

export function getSkipCueBytes(): Uint8Array {
  if (cachedSkipCueBytes) {
    return cachedSkipCueBytes;
  }

  cachedSkipCueBytes =
    typeof skipCueMp3 === "string"
      ? new Uint8Array(readFileSync(skipCueMp3))
      : new Uint8Array(skipCueMp3);

  return cachedSkipCueBytes;
}
