import { Link } from "react-router-dom";

import { Skeleton } from "../components/Skeleton";
import { useShowsSearch } from "../contexts/showsSearch";
import { lastUpdatedLabel } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import styles from "./shows.module.css";

export function ShowsPage() {
  const { feeds, total, hasLoaded, query } = useShowsSearch();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Shows</h1>
          <span className={styles.count}>{total}</span>
        </div>
      </div>

      {!hasLoaded ? (
        <div className={styles.grid}>
          {Array.from({ length: 8 }, (_, i) => (
            <div className={styles.skeletonCard} key={i}>
              <Skeleton variant="rounded" width="100%" height={0} className={styles.skeletonArt} />
              <div className={styles.info}>
                <Skeleton width="80%" height={14} />
                <Skeleton width="50%" height={10} />
              </div>
            </div>
          ))}
        </div>
      ) : feeds.length === 0 ? (
        <div className={styles.empty}>
          {query
            ? `No shows matching "${query}"`
            : "No shows registered yet. Register a feed from the home page."}
        </div>
      ) : (
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
                {feed.author ? (
                  <div className={styles.author}>{feed.author}</div>
                ) : null}
                <div className={styles.meta}>
                  <span>{feed.episodeCount} ep{feed.episodeCount !== 1 ? "s" : ""}</span>
                  {feed.latestEpisodePubDate ? (
                    <span>{lastUpdatedLabel(feed.latestEpisodePubDate)}</span>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
