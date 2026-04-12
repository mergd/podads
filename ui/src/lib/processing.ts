import type { EpisodeProcessingDiagnostics, EpisodeProcessingStatus, EpisodeProcessingSubstatus } from "@podads/shared/api";

const SUBSTATUS_LABELS: Record<EpisodeProcessingSubstatus, string> = {
  queued: "Queued",
  retry_scheduled: "Retry scheduled",
  transcribing: "Transcribing",
  detecting_ads: "Detecting ads",
  rewriting_audio: "Rewriting audio",
  finalizing: "Finalizing"
};

function formatStatus(status: EpisodeProcessingStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "processing":
      return "Processing";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return status;
  }
}

export function getEpisodeStatusLabel(
  processingStatus: EpisodeProcessingStatus,
  processingSubstatus: EpisodeProcessingSubstatus | null
): string {
  if ((processingStatus === "pending" || processingStatus === "processing") && processingSubstatus) {
    return SUBSTATUS_LABELS[processingSubstatus];
  }

  return formatStatus(processingStatus);
}

export function getEpisodeAudioStateCopy(
  processingStatus: EpisodeProcessingStatus,
  processingSubstatus: EpisodeProcessingSubstatus | null,
  hasAdFreeAudio: boolean
): string {
  if (hasAdFreeAudio) {
    return "Ad-free audio is ready.";
  }

  switch (processingSubstatus) {
    case "queued":
      return "Ad-free audio is queued for processing. You can play the official episode audio for now.";
    case "retry_scheduled":
      return "Ad-free audio hit a transient issue and will retry shortly. You can play the official episode audio for now.";
    case "transcribing":
      return "Ad-free audio is transcribing right now. You can play the official episode audio for now.";
    case "detecting_ads":
      return "Ad-free audio is analyzing ad breaks right now. You can play the official episode audio for now.";
    case "rewriting_audio":
      return "Ad-free audio is rewriting the episode right now. You can play the official episode audio for now.";
    case "finalizing":
      return "Ad-free audio is finishing up right now. You can play the official episode audio for now.";
    default:
      break;
  }

  switch (processingStatus) {
    case "failed":
      return "Ad-free audio failed to process. You can play the official episode audio for now.";
    case "skipped":
      return "Ad-free audio is not available for this episode. You can play the official episode audio instead.";
    default:
      return "Ad-free audio is still processing. You can play the official episode audio for now.";
  }
}

function formatSavedDuration(removedDurationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(removedDurationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

export function getEpisodeTimeSavedLabel(
  processingStatus: EpisodeProcessingStatus,
  diagnostics: EpisodeProcessingDiagnostics | null,
  hasAdFreeAudio: boolean
): string | null {
  if (!hasAdFreeAudio) {
    return null;
  }

  const removedDurationMs = diagnostics?.removedDurationMs;
  if (typeof removedDurationMs === "number" && Number.isFinite(removedDurationMs)) {
    return `Saved ${formatSavedDuration(removedDurationMs)}`;
  }

  return processingStatus === "ready" ? "Saved 0s" : null;
}
