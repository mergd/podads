import posthog from "posthog-js";

let initialized = false;

export function initPostHog(): void {
  const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
  const apiHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

  if (!apiKey || initialized) {
    return;
  }

  posthog.init(apiKey, {
    api_host: apiHost,
    capture_pageview: true,
    autocapture: true,
    person_profiles: "identified_only"
  });

  initialized = true;
}

export function captureUiEvent(event: string, properties: Record<string, unknown>): void {
  if (!initialized) {
    return;
  }

  posthog.capture(event, properties);
}
