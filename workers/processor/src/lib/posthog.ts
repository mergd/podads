interface PostHogProperties {
  [key: string]: string | number | boolean | null | undefined;
}

export async function capturePostHogEvent(
  env: Env,
  distinctId: string,
  event: string,
  properties: PostHogProperties
): Promise<void> {
  if (!env.POSTHOG_PROJECT_API_KEY) {
    return;
  }

  await fetch(`${env.POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      api_key: env.POSTHOG_PROJECT_API_KEY,
      distinct_id: distinctId,
      event,
      properties: {
        ...properties,
        app: "podads",
        $lib: "podads-processor"
      },
      timestamp: new Date().toISOString()
    })
  });
}

export interface AiGenerationEvent {
  traceId: string;
  spanName: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  totalCostUsd?: number | null;
  latencySeconds?: number | null;
  isError?: boolean;
  feedId: number;
  feedTitle?: string | null;
  feedSlug?: string | null;
  episodeId: number;
  episodeTitle?: string | null;
}

// See https://posthog.com/docs/ai-engineering/observability for the canonical
// $ai_* property shape that powers the LLM Analytics dashboard.
export async function capturePostHogAiGeneration(
  env: Env,
  distinctId: string,
  event: AiGenerationEvent
): Promise<void> {
  await capturePostHogEvent(env, distinctId, "$ai_generation", {
    $ai_trace_id: event.traceId,
    $ai_span_name: event.spanName,
    $ai_provider: event.provider,
    $ai_model: event.model,
    $ai_input_tokens: event.inputTokens ?? null,
    $ai_output_tokens: event.outputTokens ?? null,
    $ai_total_tokens: event.totalTokens ?? null,
    $ai_total_cost_usd: event.totalCostUsd ?? null,
    $ai_latency: event.latencySeconds ?? null,
    $ai_is_error: event.isError ?? false,
    feed_id: event.feedId,
    feed_title: event.feedTitle ?? null,
    feed_slug: event.feedSlug ?? null,
    episode_id: event.episodeId,
    episode_title: event.episodeTitle ?? null
  });
}
