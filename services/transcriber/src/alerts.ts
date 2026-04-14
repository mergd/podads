const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const DISCORD_ALERT_COOLDOWN_SECONDS = Number(process.env.DISCORD_ALERT_COOLDOWN_SECONDS) || 1800;

let lastMistralCapacityAlertAt = 0;

function shouldSendMistralCapacityAlert(): boolean {
  if (!DISCORD_WEBHOOK_URL) {
    return false;
  }

  const now = Date.now();
  const cooldownMs = Math.max(60, DISCORD_ALERT_COOLDOWN_SECONDS) * 1000;

  if ((now - lastMistralCapacityAlertAt) < cooldownMs) {
    return false;
  }

  lastMistralCapacityAlertAt = now;
  return true;
}

export async function sendMistralCapacityAlert(input: {
  model: string;
  retryAfterSeconds?: number;
  errorMessage: string;
}): Promise<void> {
  if (!shouldSendMistralCapacityAlert()) {
    return;
  }

  const retryAfter = input.retryAfterSeconds ? `${input.retryAfterSeconds}s` : "unknown";

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: "PodAds Alerts",
        content: [
          "PodAds transcription capacity alert",
          `Mistral returned a 429 rate limit for transcription.`,
          `Model: ${input.model}`,
          `Retry after: ${retryAfter}`,
          `Error: ${input.errorMessage}`
        ].join("\n")
      })
    });
  } catch (error) {
    console.error("Failed to send Discord alert", error);
  }
}
