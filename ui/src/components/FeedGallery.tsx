import { Link } from "react-router-dom";

import { lastUpdatedLabel } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import type { FeedSummary } from "@podads/shared/api";
import styles from "./FeedGallery.module.css";

interface FeedGalleryProps {
  feeds: FeedSummary[];
}

export function FeedGallery({ feeds }: FeedGalleryProps) {
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>Shows</h2>
          <span className={styles.count}>{feeds.length}</span>
        </div>
        <Link className={styles.viewAll} to="/shows" viewTransition>View all</Link>
      </div>
      <div className={styles.grid}>
        {feeds.map((feed) => (
          <Link className={styles.card} key={feed.slug} state={{ title: feed.title, imageUrl: feed.imageUrl }} to={`/${feed.slug}`} viewTransition>
            <div className={styles.artWrap} style={{ viewTransitionName: `feed-art-${feed.slug}` }}>
              {feed.imageUrl ? (
                <img alt="" className={styles.art} loading="lazy" src={feed.imageUrl} />
              ) : (
                <div className={styles.artFallback}>
                  {decodeEntities(feed.title ?? "P").charAt(0)}
                </div>
              )}
            </div>
            <div className={styles.info}>
              <h3 className={styles.name} style={{ viewTransitionName: `feed-title-${feed.slug}` }}>{decodeEntities(feed.title)}</h3>
              <div className={styles.meta}>
                <span className={styles.statusDot} data-status={feed.status} />
                <span>{feed.episodeCount} ep{feed.episodeCount !== 1 ? "s" : ""}</span>
              </div>
              {feed.latestEpisodePubDate ? (
                <div className={styles.updated}>{lastUpdatedLabel(feed.latestEpisodePubDate)}</div>
              ) : null}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
