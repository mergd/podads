import { handleEpisodeJob } from "./lib/processEpisode";
import type { EpisodeJobMessage } from "./lib/types";

function assertNever(value: never): never {
  throw new Error(`Unhandled queue message type: ${value}`);
}

async function dispatchMessage(env: Env, message: EpisodeJobMessage): Promise<void> {
  switch (message.type) {
    case "episode.process":
      await handleEpisodeJob(env, message);
      return;
    default:
      assertNever(message.type);
  }
}

export default {
  async queue(batch: MessageBatch<EpisodeJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await dispatchMessage(env, message.body as EpisodeJobMessage);
        message.ack();
      } catch {
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env, EpisodeJobMessage>;
