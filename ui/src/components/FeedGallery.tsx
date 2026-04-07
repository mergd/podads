import { Link } from "react-router-dom";

import type { FeedSummary } from "../types/api";
import styles from "./FeedGallery.module.css";

interface FeedGalleryProps {
  feeds: FeedSummary[];
}

export function FeedGallery({ feeds }: FeedGalleryProps) {
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Already de-aded feeds</h2>
          <p className={styles.subtitle}>Browse the shows that already have a canonical proxy feed.</p>
        </div>
      </div>
      <div className={styles.grid}>
        {feeds.map((feed) => (
          <Link className={styles.card} key={feed.slug} to={`/${feed.slug}`}>
            {feed.imageUrl ? <img alt="" className={styles.art} src={feed.imageUrl} /> : <div className={styles.artFallback}>F</div>}
            <div>
              <h3 className={styles.titleText}>{feed.title}</h3>
              <div className={styles.meta}>
                <span>{feed.status}</span>
                <span>{feed.language ?? "Language unknown"}</span>
              </div>
            </div>
            {feed.description ? <p className={styles.description}>{feed.description}</p> : null}
          </Link>
        ))}
      </div>
    </section>
  );
}
