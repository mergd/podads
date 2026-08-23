export const MODEL_LABELS: Record<string, string> = {
  "qwen/qwen3.7-flash": "Qwen 3.7 Flash",
  "deepseek/deepseek-v4-flash-0731": "DeepSeek V4 Flash",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "google/gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  "openai/gpt-5.6-luna": "GPT-5.6 Luna"
};

export const CASE_LABELS: Record<string, string> = {
  "jasmine-sun": "Odd Lots",
  "lex-ffmpeg": "Lex Fridman",
  "short-wave-avocados": "Short Wave",
  "signals-threads": "Signals",
  "planet-money-big-box": "Planet Money"
};

export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id.split("/").at(-1) ?? id;
}

export function caseLabel(id: string): string {
  return CASE_LABELS[id] ?? id;
}

export function formatUsd(value: number): string {
  if (value >= 0.1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(4)}`;
}

export function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (Math.abs(seconds) >= 10) {
    return `${seconds.toFixed(0)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

export function formatF1(value: number): string {
  return value.toFixed(2);
}
