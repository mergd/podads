import skipCueMp3 from "@podads/shared/assets/skip-cue.mp3";
import { spliceMp3Audio as spliceMp3AudioWithOptions } from "@podads/shared/audio";

export { canSpliceMp3, parseMp3Audio, type ParsedFrame, type ParsedMp3 } from "@podads/shared/audio";

export function spliceMp3Audio(
  buffer: ArrayBuffer,
  contentType: string,
  adSpans: Array<{ startMs: number; endMs: number }>
) {
  return spliceMp3AudioWithOptions(buffer, contentType, adSpans, {
    skipCueBytes: new Uint8Array(skipCueMp3)
  });
}
