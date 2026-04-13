export const MAX_AUTOMATIC_EPISODE_PROCESSING_ATTEMPTS = 2;

export interface EpisodeQueueMessage {
  type: "episode.process";
  jobId: string;
  feedId: number;
  episodeId: number;
  processingVersion: string;
  enqueuedAt: string;
  expectedDurationSeconds?: number;
  pollAttempt?: number;
}
