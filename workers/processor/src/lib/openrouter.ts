interface OpenRouterUsage {
  cost?: number | string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterMessage {
  content?: string | Array<{ type?: string; text?: string }>;
}

interface OpenRouterChoice {
  message?: OpenRouterMessage;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: {
    message?: string;
  };
}

export class OpenRouterRequestError extends Error {
  status: number;
  body: string;
  retryAfterSeconds?: number;

  constructor(status: number, body: string, retryAfterSeconds?: number) {
    super(`OpenRouter chat completion failed (${status}): ${body}`);
    this.name = "OpenRouterRequestError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface OpenRouterMetrics {
  estimatedCostUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestDurationMs: number;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterSeconds(headerValue: string | null, body: string): number | undefined {
  if (headerValue) {
    const numeric = Number.parseInt(headerValue, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }

    const dateMs = Date.parse(headerValue);
    if (Number.isFinite(dateMs)) {
      const delaySeconds = Math.ceil((dateMs - Date.now()) / 1000);
      if (delaySeconds > 0) {
        return delaySeconds;
      }
    }
  }

  const durationMatch = body.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!durationMatch) {
    return undefined;
  }

  const hours = Number.parseInt(durationMatch[1] ?? "0", 10) || 0;
  const minutes = Number.parseInt(durationMatch[2] ?? "0", 10) || 0;
  const seconds = Number.parseInt(durationMatch[3] ?? "0", 10) || 0;
  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

  return totalSeconds > 0 ? totalSeconds : undefined;
}

function extractMessageText(message: OpenRouterMessage | undefined): string {
  const content = message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .join("\n")
      .trim();
  }

  return "";
}

function extractJsonText(payload: OpenRouterResponse): string {
  if (payload.error?.message) {
    throw new Error(`OpenRouter request failed: ${payload.error.message}`);
  }

  const text = extractMessageText(payload.choices?.[0]?.message);

  if (!text) {
    throw new Error("OpenRouter did not return a text response.");
  }

  return text;
}

function getAppReferer(env: Env): string | undefined {
  const appBaseUrl = env.APP_BASE_URL?.trim();
  return appBaseUrl && /^https?:\/\//.test(appBaseUrl) ? appBaseUrl : undefined;
}

export function getOpenRouterMetrics(payload: OpenRouterResponse, requestDurationMs: number): OpenRouterMetrics {
  const usage = payload.usage;
  const rawCost = usage?.cost;
  const estimatedCostUsd = typeof rawCost === "number" ? rawCost : Number(rawCost ?? 0);

  return {
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : 0,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    requestDurationMs
  };
}

export function isRetryableOpenRouterStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function parseStructuredOutput<T>(payload: OpenRouterResponse): T {
  const text = extractJsonText(payload);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("OpenRouter returned invalid JSON.");
  }
}

export async function createOpenRouterChatCompletion(
  env: Env,
  body: Record<string, unknown>
): Promise<{ payload: OpenRouterResponse; metrics: OpenRouterMetrics }> {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY secret.");
  }

  const startedAt = Date.now();
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      ...(getAppReferer(env) ? { "HTTP-Referer": getAppReferer(env) } : {}),
      "X-Title": "PodAds"
    },
    body: JSON.stringify(body)
  });
  const requestDurationMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text();
    const retryAfterSeconds = isRetryableOpenRouterStatus(response.status)
      ? parseRetryAfterSeconds(response.headers.get("retry-after"), text) ?? DEFAULT_RETRY_AFTER_SECONDS
      : undefined;
    throw new OpenRouterRequestError(response.status, text, retryAfterSeconds);
  }

  const payload = (await response.json()) as OpenRouterResponse;

  return {
    payload,
    metrics: getOpenRouterMetrics(payload, requestDurationMs)
  };
}
