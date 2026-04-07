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
