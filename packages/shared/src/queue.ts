export interface EpisodeQueueMessage {
  type: "episode.process";
  jobId: string;
  feedId: number;
  episodeId: number;
  processingVersion: string;
  enqueuedAt: string;
  batchWindowSeconds?: number;
  expectedDurationSeconds?: number;
  pollAttempt?: number;
}
