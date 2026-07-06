import { Container } from "@cloudflare/containers";

/**
 * Runs services/transcriber (bun + ffmpeg) as a Cloudflare Container so we no
 * longer need Railway. The processor talks to it through the TRANSCRIBER
 * durable object binding; it is never exposed on a public route, so the
 * gateway token check inside the service stays disabled (we simply don't set
 * TRANSCRIPTION_GATEWAY_TOKEN in the container environment).
 */
export class TranscriberContainer extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const passthrough: Record<string, string | undefined> = {
      SPEED_MULTIPLIER: env.SPEED_MULTIPLIER,
      GROQ_API_KEY: env.GROQ_API_KEY,
      GROQ_API_KEYS: env.GROQ_API_KEYS,
      MISTRAL_API_KEY: env.MISTRAL_API_KEY,
      MISTRAL_MODEL: env.MISTRAL_MODEL,
      DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL,
      DISCORD_ALERT_COOLDOWN_SECONDS: env.DISCORD_ALERT_COOLDOWN_SECONDS
    };

    this.envVars = { PORT: "8000" };
    for (const [key, value] of Object.entries(passthrough)) {
      if (value) {
        this.envVars[key] = value;
      }
    }
  }
}

export async function transcriberFetch(
  env: Env,
  path: string,
  init: RequestInit
): Promise<Response> {
  const id = env.TRANSCRIBER.idFromName("transcriber");
  const stub = env.TRANSCRIBER.get(id);
  return stub.fetch(`http://transcriber${path}`, init);
}
