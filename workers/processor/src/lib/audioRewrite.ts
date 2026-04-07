import type { AdSpan } from "./types";

function extensionFromContentType(contentType: string | null): string {
  switch (contentType) {
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    default:
      return "mp3";
  }
}

export async function rewriteAudio(
  env: Env,
  sourceUrl: string,
  sourceContentType: string | null,
  feedId: number,
  episodeId: number,
  processingVersion: string,
  adSpans: AdSpan[]
): Promise<{ key: string; bytesWritten: number }> {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": "podads-bot/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Audio download failed with status ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? sourceContentType ?? "audio/mpeg";
  const extension = extensionFromContentType(contentType);
  const key = `cleaned/${feedId}/${episodeId}/${processingVersion}.${extension}`;
  const arrayBuffer = await response.arrayBuffer();

  await env.AUDIO_BUCKET.put(key, arrayBuffer, {
    httpMetadata: {
      contentType
    },
    customMetadata: {
      adSpanCount: String(adSpans.length),
      processingVersion
    }
  });

  return {
    key,
    bytesWritten: arrayBuffer.byteLength
  };
}
