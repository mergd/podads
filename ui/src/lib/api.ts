import type { ComplaintRequest, FeedDetailResponse, HomeResponse, RegisterFeedResponse } from "../types/api";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

async function parseJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload ? payload.error : "Request failed";
    throw new Error(message ?? "Request failed");
  }

  return payload as T;
}

export async function fetchHome(): Promise<HomeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/home`);
  return parseJson<HomeResponse>(response);
}

export async function fetchFeed(slug: string): Promise<FeedDetailResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/${slug}`);
  return parseJson<FeedDetailResponse>(response);
}

export async function registerFeed(url: string): Promise<RegisterFeedResponse> {
  const response = await fetch(`${API_BASE_URL}/api/feeds/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  return parseJson<RegisterFeedResponse>(response);
}

export async function submitComplaint(payload: ComplaintRequest): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  await parseJson<{ ok: boolean }>(response);
}
