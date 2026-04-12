import styles from "./LatestEpisodes.module.css";
import type { EpisodeSummary } from "@podads/shared/api";

interface LatestEpisodesProps {
  episodes: EpisodeSummary[];
}

export function LatestEpisodes({ episodes }: LatestEpisodesProps) {
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Latest de-aded episodes</h2>
          <p className={styles.subtitle}>A firehose of the newest episodes the system has already touched.</p>
        </div>
      </div>
      <div className={styles.list}>
        {episodes.map((episode) => (
          <article className={styles.card} key={episode.id}>
            {episode.imageUrl ? (
              <img alt="" className={styles.art} src={episode.imageUrl} />
            ) : (
              <div className={styles.artFallback}>RSS</div>
            )}
            <div className={styles.meta}>
              <div className={styles.feedName}>{episode.feedTitle}</div>
              <h3 className={styles.episodeTitle}>{episode.title}</h3>
              <div className={styles.supporting}>
                <span>{episode.processingStatus}</span>
                <span>{episode.pubDate ?? "Date unavailable"}</span>
                <span>{episode.duration ?? "Duration unavailable"}</span>
              </div>
            </div>
            <div className={styles.actions}>
              <a className={styles.link} href={`/${episode.feedSlug}`}>
                View feed
              </a>
              <a className={styles.link} href={episode.reportUrl}>
                Report issue
              </a>
              <span className={styles.status}>{episode.processingStatus}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
