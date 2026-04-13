import type { EpisodeJobMessage, EpisodeRecord } from "./types";

const DISCORD_ERROR_FIELD_LIMIT = 1000;

function truncateFieldValue(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function formatFeedLabel(episode: EpisodeRecord | null, fallbackFeedId: number): string {
  const parts = [episode?.feed_title?.trim() || "Unknown feed"];

  if (episode?.feed_slug) {
    parts.push(`slug \`${episode.feed_slug}\``);
  }

  parts.push(`id \`${fallbackFeedId}\``);
  return parts.join(" | ");
}

function formatEpisodeLabel(episode: EpisodeRecord | null, fallbackEpisodeId: number): string {
  const parts = [episode?.title?.trim() || "Unknown episode"];
  parts.push(`id \`${fallbackEpisodeId}\``);
  return parts.join(" | ");
}

export async function notifyEpisodeProcessingFailure(
  env: Env,
  message: EpisodeJobMessage,
  errorMessage: string,
  episode: EpisodeRecord | null
): Promise<void> {
  if (!env.DISCORD_PROCESSING_FAILURE_WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(env.DISCORD_PROCESSING_FAILURE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username: "PodAds Processor",
        embeds: [
          {
            title: "Episode processing failed",
            color: 15_562_165,
            fields: [
              {
                name: "Feed",
                value: formatFeedLabel(episode, message.feedId)
              },
              {
                name: "Episode",
                value: formatEpisodeLabel(episode, message.episodeId)
              },
              {
                name: "Processing version",
                value: `\`${message.processingVersion}\``,
                inline: true
              },
              {
                name: "Job ID",
                value: `\`${message.jobId}\``,
                inline: true
              },
              {
                name: "Reason",
                value: truncateFieldValue(errorMessage, DISCORD_ERROR_FIELD_LIMIT)
              }
            ],
            timestamp: new Date().toISOString()
          }
        ]
      })
    });

    if (response.ok) {
      return;
    }

    console.warn(
      JSON.stringify({
        event: "episode_processing_failure_webhook_failed",
        episodeId: message.episodeId,
        feedId: message.feedId,
        status: response.status,
        statusText: response.statusText
      })
    );
  } catch (error) {
    const fetchError = error instanceof Error ? error.message : "Unknown Discord webhook error";
    console.warn(
      JSON.stringify({
        event: "episode_processing_failure_webhook_failed",
        episodeId: message.episodeId,
        feedId: message.feedId,
        error: fetchError
      })
    );
  }
}
