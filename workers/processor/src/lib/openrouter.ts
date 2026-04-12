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

export interface OpenRouterMetrics {
  estimatedCostUsd: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestDurationMs: number;
}

function getOpenRouterBaseUrl(env: Env): string {
  const baseUrl = env.OPENROUTER_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://openrouter.ai/api/v1";
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
  const response = await fetch(`${getOpenRouterBaseUrl(env)}/chat/completions`, {
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
    throw new Error(`OpenRouter chat completion failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as OpenRouterResponse;

  return {
    payload,
    metrics: getOpenRouterMetrics(payload, requestDurationMs)
  };
}
