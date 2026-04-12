import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TranscriptionResult } from "./groq.js";

const execFileAsync = promisify(execFile);

export async function transcribeLocal(
  audioPath: string,
  model: string,
  speedMultiplier: number,
): Promise<TranscriptionResult> {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    WHISPER_SCRIPT,
    audioPath,
    model,
  ], { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });

  const raw = JSON.parse(stdout) as {
    segments: { start: number; end: number; text: string }[];
    duration: number;
  };

  const segments = raw.segments.map((s, i) => ({
    id: i,
    start: Math.round(s.start * speedMultiplier * 100) / 100,
    end: Math.round(s.end * speedMultiplier * 100) / 100,
    text: s.text.trim(),
  }));

  const duration = segments.length > 0 ? segments[segments.length - 1]!.end : 0;

  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    duration,
    provider: "local",
    estimatedCostUsd: null,
  };
}

const WHISPER_SCRIPT = `
import sys, json
from faster_whisper import WhisperModel

audio_path, model_name = sys.argv[1], sys.argv[2]
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments_iter, info = model.transcribe(
    audio_path,
    beam_size=5,
    language="en",
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),
)
segments = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments_iter]
duration = segments[-1]["end"] if segments else 0
json.dump({"segments": segments, "duration": duration}, sys.stdout)
`;
