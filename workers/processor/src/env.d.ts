declare global {
  interface Env {
    DISCORD_PROCESSING_FAILURE_WEBHOOK_URL?: string;
    TRANSCRIPTION_GATEWAY_URL: string;
    TRANSCRIPTION_GATEWAY_TOKEN?: string;
    OPENROUTER_API_KEY: string;
    PROCESSING_QUEUE: Queue;
  }
}

export {};
