interface PostHogProperties {
  [key: string]: string | number | boolean | null | undefined;
}

export interface CaptureEventInput {
  distinctId: string;
  event: string;
  properties?: PostHogProperties;
}

export async function capturePostHogEvent(env: Env, input: CaptureEventInput): Promise<void> {
  if (!env.POSTHOG_PROJECT_API_KEY) {
    return;
  }

  const body = {
    api_key: env.POSTHOG_PROJECT_API_KEY,
    event: input.event,
    distinct_id: input.distinctId,
    properties: {
      ...input.properties,
      $lib: "podads-worker",
      app: "podads"
    },
    timestamp: new Date().toISOString()
  };

  await fetch(`${env.POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
