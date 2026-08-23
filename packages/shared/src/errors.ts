const MAX_SUMMARY_CHARS = 480;

const GATEWAY_PREFIX = /^Transcription gateway failed \((\d+)\):\s*/;
const NOISE_LINE_PATTERN =
  /^(?:ffmpeg version|built with|configuration:|lib(?:av|sw|post)|size=\s*\d|press \[q\]|stream mapping:|output #\d|input #\d|metadata:|encoder\s*:)/i;
const METADATA_LINE_PATTERN =
  /^(?:lyrics-|title\s*:|album\s*:|genre\s*:|date\s*:|comment\s*:|tit2|talb|tcon|tdrc|tsse|lyrics-eng)/i;

interface GatewayErrorPayload {
  error?: unknown;
  message?: unknown;
  summary?: unknown;
  stage?: unknown;
  ffmpeg_exit_code?: unknown;
  last_output_time?: unknown;
  code?: unknown;
}

function truncateSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd()}...`;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (NOISE_LINE_PATTERN.test(trimmed) || METADATA_LINE_PATTERN.test(trimmed)) {
    return true;
  }

  if (trimmed.startsWith("Command failed:")) {
    return true;
  }

  if (/^:?\s*</.test(trimmed) || /<\/(?:p|a|br)>/i.test(trimmed)) {
    return true;
  }

  if (/^[A-Z0-9]{4}\s*:/.test(trimmed) && trimmed.length > 80) {
    return true;
  }

  return /^[-: ]+$/.test(trimmed);
}

function extractLastOutputTime(text: string): string | null {
  const matches = [...text.matchAll(/\btime=(\d{2}:\d{2}:\d{2}\.\d+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function extractFfmpegExitCode(text: string, payload: GatewayErrorPayload | null): number | null {
  const fromPayload = asFiniteNumber(payload?.ffmpeg_exit_code) ?? asFiniteNumber(payload?.code);
  if (fromPayload !== null) {
    return fromPayload;
  }

  const match =
    text.match(/\bffmpeg exit(?:ed(?: with code)?)? (\d{1,3})\b/i)
    ?? text.match(/\bcode["']?\s*[:=]\s*["']?(\d{1,3})/);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function usefulFfmpegLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line))
    .filter((line) =>
      /error|failed|invalid|cannot|unable|no such|permission|conversion|disk|killed|signal|timeout|audio prepare/i.test(line)
    )
    .slice(-4);
}

function summarizeFfmpegDump(text: string, payload: GatewayErrorPayload | null): string {
  const exitCode = extractFfmpegExitCode(text, payload);
  const lastOutputTime = asNonEmptyString(payload?.last_output_time) ?? extractLastOutputTime(text);
  const usefulLines = usefulFfmpegLines(text);
  const parts: string[] = [];

  if (exitCode !== null) {
    parts.push(`ffmpeg exit ${exitCode}`);
  }

  if (lastOutputTime) {
    parts.push(`last output time ${lastOutputTime}`);
  }

  if (usefulLines.length > 0) {
    parts.push(usefulLines.join(" | "));
  } else if (exitCode !== null) {
    parts.push("no ffmpeg error line; encode likely failed while writing the output file");
  }

  return parts.join(". ");
}

function looksLikeFfmpegDump(text: string): boolean {
  return text.includes("Command failed:") || (text.includes("ffmpeg version") && text.length > MAX_SUMMARY_CHARS);
}

function summarizePayload(payload: GatewayErrorPayload, raw: string): string {
  const errorLabel = asNonEmptyString(payload.error);
  if (errorLabel && errorLabel !== "Internal Server Error") {
    return errorLabel;
  }

  const message = asNonEmptyString(payload.message);
  if (message && looksLikeFfmpegDump(message)) {
    return summarizeFfmpegDump(message, payload);
  }

  const explicitSummary = asNonEmptyString(payload.summary);
  const stage = asNonEmptyString(payload.stage);
  const exitCode = extractFfmpegExitCode(raw, payload);
  const lastOutputTime = asNonEmptyString(payload.last_output_time);
  const parts: string[] = [];

  if (stage) {
    parts.push(stage.replace(/_/g, " "));
  }

  if (exitCode !== null) {
    parts.push(`ffmpeg exit ${exitCode}`);
  }

  if (lastOutputTime) {
    parts.push(`last output time ${lastOutputTime}`);
  }

  const detail = explicitSummary ?? message;
  if (detail && !parts.includes(detail)) {
    parts.push(detail);
  }

  if (parts.length === 0) {
    return summarizeFfmpegDump(raw, payload);
  }

  return parts.join(": ");
}

export function summarizeProcessingError(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Unknown processing failure";
  }

  const gatewayMatch = trimmed.match(GATEWAY_PREFIX);
  const body = gatewayMatch ? trimmed.slice(gatewayMatch[0].length) : trimmed;
  const parsed = tryParseJson(body);
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as GatewayErrorPayload)
    : null;

  let summary = payload
    ? summarizePayload(payload, body)
    : looksLikeFfmpegDump(body)
      ? summarizeFfmpegDump(body, null)
      : body;

  if (!summary) {
    summary = "Unknown processing failure";
  }

  if (gatewayMatch?.[1]) {
    const prefix = `Transcription gateway failed (${gatewayMatch[1]})`;
    summary = summary.startsWith(prefix) ? summary : `${prefix}: ${summary}`;
  }

  return truncateSummary(summary);
}
