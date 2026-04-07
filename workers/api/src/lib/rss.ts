import { XMLParser } from "fast-xml-parser";

import type { EpisodeSummary, FeedSummary, SourceEpisode, SourceFeed } from "./types";

const parser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (value && typeof value === "object" && "#text" in value) {
    return getString((value as { "#text"?: unknown })["#text"]);
  }

  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = getString(value);
    if (next) {
      return next;
    }
  }

  return null;
}

function readCategoryValues(value: unknown): string[] {
  return asArray(value)
    .map((entry) => getString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function pickEpisodeImage(item: Record<string, unknown>, channel: Record<string, unknown>): string | null {
  const itemImage = item["itunes:image"];
  const channelImage = channel["itunes:image"];

  if (itemImage && typeof itemImage === "object" && "href" in itemImage) {
    return getString((itemImage as { href?: unknown }).href);
  }

  if (channelImage && typeof channelImage === "object" && "href" in channelImage) {
    return getString((channelImage as { href?: unknown }).href);
  }

  const imageNode = item.image;
  if (imageNode && typeof imageNode === "object") {
    return firstString((imageNode as { url?: unknown }).url);
  }

  return null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderOptionalTag(tag: string, value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return `<${tag}>${escapeXml(value)}</${tag}>`;
}

export function parseSourceFeed(xml: string): SourceFeed {
  const parsed = parser.parse(xml) as { rss?: { channel?: Record<string, unknown> } };
  const channel = parsed.rss?.channel;

  if (!channel) {
    throw new Error("The source feed did not contain an RSS channel.");
  }

  const channelImage = channel.image as { url?: unknown } | undefined;
  const items = asArray(channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const episodes: SourceEpisode[] = items
    .map((item) => {
      const enclosure = item.enclosure as { url?: unknown; type?: unknown; length?: unknown } | undefined;
      const sourceEnclosureUrl = getString(enclosure?.url);

      if (!sourceEnclosureUrl) {
        return null;
      }

      const guid = firstString(item.guid);
      const pubDate = firstString(item.pubDate);
      const title = firstString(item.title);
      const episodeKey =
        guid ??
        sourceEnclosureUrl ??
        `${title ?? "episode"}::${pubDate ?? "unknown-date"}`;

      return {
        episodeKey,
        guid,
        title,
        description: firstString(item.description, item["content:encoded"]),
        episodeLink: firstString(item.link),
        author: firstString(item.author, item["itunes:author"]),
        imageUrl: pickEpisodeImage(item, channel),
        pubDate,
        duration: firstString(item["itunes:duration"]),
        sourceEnclosureUrl,
        sourceEnclosureType: getString(enclosure?.type),
        sourceEnclosureLength: getString(enclosure?.length)
      } satisfies SourceEpisode;
    })
    .filter((episode): episode is SourceEpisode => episode !== null);

  return {
    title: firstString(channel.title) ?? "Untitled podcast",
    description: firstString(channel.description),
    siteLink: firstString(channel.link),
    imageUrl:
      firstString(
        channelImage?.url,
        channel["itunes:image"] && typeof channel["itunes:image"] === "object"
          ? (channel["itunes:image"] as { href?: unknown }).href
          : null
      ),
    author: firstString(channel["itunes:author"], channel.managingEditor),
    language: firstString(channel.language),
    categories: readCategoryValues(channel.category),
    metadata: {
      generator: firstString(channel.generator),
      copyright: firstString(channel.copyright)
    },
    episodes
  };
}

export function buildProxiedRssXml(feed: FeedSummary, episodes: EpisodeSummary[], proxiedFeedUrl: string): string {
  const imageTag = feed.imageUrl
    ? `<image>${renderOptionalTag("url", feed.imageUrl)}${renderOptionalTag("title", feed.title)}${renderOptionalTag("link", feed.siteLink)}</image>`
    : "";
  const categories = feed.categories.map((category) => renderOptionalTag("category", category)).join("");
  const items = episodes
    .map((episode) => {
      const enclosureUrl = episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl;

      return `<item>${renderOptionalTag("title", episode.title)}${renderOptionalTag("description", episode.description)}${renderOptionalTag("link", episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl)}${renderOptionalTag("guid", String(episode.id))}${renderOptionalTag("pubDate", episode.pubDate)}${renderOptionalTag("itunes:duration", episode.duration)}${episode.imageUrl ? `<itunes:image href="${escapeXml(episode.imageUrl)}" />` : ""}<enclosure url="${escapeXml(enclosureUrl)}" type="audio/mpeg" />${renderOptionalTag("podads:reportUrl", episode.reportUrl)}${renderOptionalTag("podads:status", episode.processingStatus)}</item>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podads="https://podads.app/ns/1.0">
  <channel>
    ${renderOptionalTag("title", feed.title)}
    ${renderOptionalTag("description", feed.description)}
    ${renderOptionalTag("link", feed.siteLink)}
    ${renderOptionalTag("language", feed.language)}
    ${renderOptionalTag("itunes:author", feed.author)}
    ${categories}
    ${imageTag}
    ${renderOptionalTag("podads:source", proxiedFeedUrl)}
    ${items}
  </channel>
</rss>`;
}
