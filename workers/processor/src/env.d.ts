declare global {
  interface Env {
    APP_BASE_URL?: string;
    CLASSIFICATION_PROVIDER?: string;
    DISCORD_PROCESSING_FAILURE_WEBHOOK_URL?: string;
    TRANSCRIBER: DurableObjectNamespace;
    GROQ_API_KEY?: string;
    GROQ_API_KEYS?: string;
    MISTRAL_API_KEY?: string;
    MISTRAL_MODEL?: string;
    SPEED_MULTIPLIER?: string;
    DISCORD_WEBHOOK_URL?: string;
    DISCORD_ALERT_COOLDOWN_SECONDS?: string;
    OPENROUTER_API_KEY: string;
    PROCESSING_QUEUE: Queue;
  }
}

export {};
