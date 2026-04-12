import { handleEpisodeJob, type EpisodeJobResult } from "./lib/processEpisode";
import { recoverStaleEpisodeJobs } from "./lib/staleJobs";
import type { EpisodeJobMessage } from "./lib/types";

function assertNever(value: never): never {
  throw new Error(`Unhandled queue message type: ${value}`);
}

async function dispatchMessage(env: Env, message: EpisodeJobMessage): Promise<EpisodeJobResult> {
  switch (message.type) {
    case "episode.process":
      return handleEpisodeJob(env, message);
    default:
      assertNever(message.type);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok", { status: 200 });
  },

  async queue(batch: MessageBatch<EpisodeJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await dispatchMessage(env, message.body as EpisodeJobMessage);

        switch (result.kind) {
          case "ack":
            message.ack();
            break;
          case "retry":
            message.retry({ delaySeconds: result.delaySeconds });
            break;
          default:
            assertNever(result);
        }
      } catch (error) {
        message.retry();
      }
    }
  },

  async scheduled(_event, env): Promise<void> {
    await recoverStaleEpisodeJobs(env);
  }
} satisfies ExportedHandler<Env, EpisodeJobMessage>;
