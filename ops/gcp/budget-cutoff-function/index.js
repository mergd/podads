const { GoogleAuth } = require("google-auth-library");

const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function decodeBudgetMessage(cloudEvent) {
  const encoded = cloudEvent?.data?.message?.data;

  if (!encoded) {
    throw new Error("Missing Pub/Sub message payload.");
  }

  const payload = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(payload);
}

async function getAccessToken() {
  const auth = new GoogleAuth({
    scopes: [CLOUD_SCOPE]
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  if (!accessToken) {
    throw new Error("Could not acquire Google access token.");
  }

  return typeof accessToken === "string" ? accessToken : accessToken.token;
}

async function fetchBillingInfo(projectId, accessToken) {
  const response = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch billing info (${response.status}): ${body}`);
  }

  return response.json();
}

async function disableBilling(projectId, accessToken) {
  const response = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      billingAccountName: ""
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to disable billing (${response.status}): ${body}`);
  }

  return response.json();
}

exports.hardCutoff = async (cloudEvent) => {
  const projectId = process.env.TARGET_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const threshold = Number(process.env.CUTOFF_THRESHOLD || "1");
  const dryRun = process.env.DRY_RUN === "true";
  const payload = decodeBudgetMessage(cloudEvent);

  const alertThresholdExceeded = Number(payload.alertThresholdExceeded || 0);
  const costAmount = Number(payload.costAmount || 0);
  const budgetAmount = Number(payload.budgetAmount || 0);

  console.log(
    JSON.stringify({
      message: "Received budget notification",
      budgetDisplayName: payload.budgetDisplayName,
      alertThresholdExceeded,
      costAmount,
      budgetAmount,
      projectId
    })
  );

  if (alertThresholdExceeded < threshold && costAmount < budgetAmount) {
    console.log(
      JSON.stringify({
        message: "Threshold not met; taking no action",
        threshold,
        alertThresholdExceeded,
        costAmount,
        budgetAmount
      })
    );
    return;
  }

  const accessToken = await getAccessToken();
  const billingInfo = await fetchBillingInfo(projectId, accessToken);

  if (!billingInfo.billingEnabled) {
    console.log(JSON.stringify({ message: "Billing already disabled", projectId }));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ message: "Dry run enabled; billing would be disabled now", projectId }));
    return;
  }

  const result = await disableBilling(projectId, accessToken);
  console.log(JSON.stringify({ message: "Billing disabled", projectId, result }));
};
