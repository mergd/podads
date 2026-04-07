import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchFeed } from "../lib/api";
import { captureUiEvent } from "../lib/posthog";
import type { FeedDetailResponse } from "../types/api";
import styles from "./feed.module.css";

export function FeedPage() {
  const { slug = "" } = useParams();
  const [detail, setDetail] = useState<FeedDetailResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadFeed() {
      try {
        const nextDetail = await fetchFeed(slug);
        if (active) {
          setDetail(nextDetail);
          captureUiEvent("feed_detail_viewed", { feed_slug: slug });
        }
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load this feed.");
        }
      }
    }

    void loadFeed();

    return () => {
      active = false;
    };
  }, [slug]);

  if (errorMessage) {
    return <div>{errorMessage}</div>;
  }

  if (!detail) {
    return <div>Loading feed...</div>;
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.meta}>
          <div className={styles.eyebrow}>Canonical proxied feed</div>
          <h1 className={styles.title}>{detail.feed.title}</h1>
          {detail.feed.description ? <p className={styles.description}>{detail.feed.description}</p> : null}
          <div className={styles.actions}>
            <a className={styles.button} href={detail.proxiedFeedUrl} rel="noreferrer" target="_blank">
              Open proxied RSS
            </a>
            <Link className={styles.button} to={`/report?feed=${detail.feed.slug}`}>
              Report a problem
            </Link>
          </div>
        </div>
        {detail.feed.imageUrl ? (
          <img alt="" className={styles.cover} src={detail.feed.imageUrl} />
        ) : (
          <div className={styles.coverFallback}>F</div>
        )}
      </section>

      <section className={styles.list}>
        {detail.episodes.map((episode) => (
          <article className={styles.episode} key={episode.id}>
            <h2 className={styles.episodeTitle}>{episode.title}</h2>
            <div className={styles.row}>
              <span>{episode.processingStatus}</span>
              <span>{episode.pubDate ?? "Date unavailable"}</span>
              <span>{episode.duration ?? "Duration unavailable"}</span>
            </div>
            {episode.description ? <div>{episode.description}</div> : null}
            <div className={styles.row}>
              <a href={episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl} rel="noreferrer" target="_blank">
                Open audio
              </a>
              <a className={styles.reportLink} href={episode.reportUrl}>
                Report issue
              </a>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
