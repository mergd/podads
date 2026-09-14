import { gatewayTranscription } from "../providers/transcription/gateway";
import type { TranscriberTier } from "./containerSizing";
import type { EpisodeRecord, TranscriptResult } from "./types";

export async function generateTranscript(
  env: Env,
  episode: EpisodeRecord,
  _processingVersion: string,
  _state: Record<string, unknown>,
  tier: TranscriberTier
): Promise<TranscriptResult> {
  return gatewayTranscription(env, episode, undefined, tier);
}
