const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const DISCORD_ALERT_COOLDOWN_SECONDS = Number(process.env.DISCORD_ALERT_COOLDOWN_SECONDS) || 1800;

let lastGroqCapacityAlertAt = 0;

function shouldSendGroqCapacityAlert(): boolean {
  if (!DISCORD_WEBHOOK_URL) {
    return false;
  }

  const now = Date.now();
  const cooldownMs = Math.max(60, DISCORD_ALERT_COOLDOWN_SECONDS) * 1000;

  if ((now - lastGroqCapacityAlertAt) < cooldownMs) {
    return false;
  }

  lastGroqCapacityAlertAt = now;
  return true;
}

export async function sendGroqCapacityAlert(input: {
  keyCount: number;
  retryAfterSeconds?: number;
  errorMessage: string;
}): Promise<void> {
  if (!shouldSendGroqCapacityAlert()) {
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
          `All configured Groq orgs are cooling down or rate limited.`,
          `Configured org keys: ${input.keyCount}`,
          `Retry after: ${retryAfter}`,
          `Error: ${input.errorMessage}`
        ].join("\n")
      })
    });
  } catch (error) {
    console.error("Failed to send Discord alert", error);
  }
}
