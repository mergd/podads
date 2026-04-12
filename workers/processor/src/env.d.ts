declare global {
  interface Env {
    TRANSCRIPTION_GATEWAY_URL: string;
    TRANSCRIPTION_GATEWAY_TOKEN?: string;
    OPENROUTER_API_KEY: string;
    PROCESSING_QUEUE: Queue;
  }
}

export {};
