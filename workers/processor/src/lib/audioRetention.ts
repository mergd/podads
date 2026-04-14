const CLEANED_AUDIO_PREFIX = "cleaned/";
const CLEANED_AUDIO_RETENTION_DAYS = 90;
const CLEANED_AUDIO_RETENTION_MS = CLEANED_AUDIO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const R2_LIST_PAGE_SIZE = 1000;

export interface ExpiredCleanedAudioResult {
  scanned: number;
  deleted: number;
}

export async function expireOldCleanedAudio(env: Env): Promise<ExpiredCleanedAudioResult> {
  const cutoffMs = Date.now() - CLEANED_AUDIO_RETENTION_MS;
  let scanned = 0;
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const page = await env.AUDIO_BUCKET.list({
      prefix: CLEANED_AUDIO_PREFIX,
      cursor,
      limit: R2_LIST_PAGE_SIZE
    });
    const expiredKeys = page.objects.flatMap((object) => {
      scanned += 1;
      return object.uploaded.getTime() <= cutoffMs ? [object.key] : [];
    });

    if (expiredKeys.length > 0) {
      await env.AUDIO_BUCKET.delete(expiredKeys);
      deleted += expiredKeys.length;
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    scanned,
    deleted
  };
}
