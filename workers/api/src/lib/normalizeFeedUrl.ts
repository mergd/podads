const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid"
]);

function trimTrailingSlashes(pathname: string): string {
  if (pathname === "/") {
    return pathname;
  }

  return pathname.replace(/\/+$/, "");
}

function sortQueryParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  const entries: Array<[string, string]> = [];

  searchParams.forEach((value, key) => {
    entries.push([key, value]);
  });

  entries.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  for (const [key, value] of entries) {
    next.append(key, value);
  }

  return next;
}

export function normalizeFeedUrl(input: string): string {
  const url = new URL(input.trim());

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => {
    keys.push(key);
  });

  for (const key of keys) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  url.pathname = trimTrailingSlashes(url.pathname);
  url.search = sortQueryParams(url.searchParams).toString();

  return url.toString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashNormalizedUrl(normalizedUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedUrl));
  return bytesToHex(new Uint8Array(digest));
}

export function slugFromHash(hash: string): string {
  return `feed-${hash.slice(0, 12)}`;
}
