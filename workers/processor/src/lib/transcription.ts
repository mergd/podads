import { mockTranscription } from "../providers/transcription/mock";
import type { TranscriptResult } from "./types";

type TranscriptionProvider = "mock";

function assertNever(value: never): never {
  throw new Error(`Unhandled transcription provider: ${value}`);
}

export async function generateTranscript(env: Env, sourceUrl: string): Promise<TranscriptResult> {
  const provider = env.TRANSCRIPTION_PROVIDER as TranscriptionProvider;

  switch (provider) {
    case "mock":
      return mockTranscription(env.TRANSCRIPTION_MODEL, sourceUrl);
    default:
      return assertNever(provider);
  }
}
