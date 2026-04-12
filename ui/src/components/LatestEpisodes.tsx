import { Link } from "react-router-dom";

import { formatEpisodeDuration, isNewContent, shortDate } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import { getEpisodeStatusLabel } from "../lib/processing";
import styles from "./LatestEpisodes.module.css";
import type { EpisodeSummary } from "@podads/shared/api";

interface LatestEpisodesProps {
  episodes: EpisodeSummary[];
}

export function LatestEpisodes({ episodes }: LatestEpisodesProps) {
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>Latest episodes</h2>
        <span className={styles.count}>{episodes.length}</span>
      </div>
      <div className={styles.list}>
        {episodes.map((episode) => (
          <article className={styles.row} key={episode.id}>
            <div className={styles.artWrap}>
              {episode.imageUrl ? (
                <img alt="" className={styles.art} loading="lazy" src={episode.imageUrl} />
              ) : (
                <div className={styles.artFallback}>
                  {decodeEntities(episode.feedTitle ?? "E").charAt(0)}
                </div>
              )}
            </div>
            <div className={styles.content}>
              <Link className={styles.feedName} state={{ title: episode.feedTitle, imageUrl: episode.imageUrl }} to={`/${episode.feedSlug}`} viewTransition>
                {decodeEntities(episode.feedTitle)}
              </Link>
              <div className={styles.titleRow}>
                <Link className={styles.episodeTitleLink} state={{ title: episode.title, imageUrl: episode.imageUrl, feedTitle: episode.feedTitle }} to={`/${episode.feedSlug}/episodes/${episode.id}`} viewTransition>
                  <h3 className={styles.episodeTitle}>{decodeEntities(episode.title)}</h3>
                </Link>
                {isNewContent(episode.pubDate) ? <span className={styles.newBadge}>New</span> : null}
              </div>
              <div className={styles.meta}>
                {episode.pubDate ? <span>{shortDate(episode.pubDate)}</span> : null}
                {episode.duration ? <span>{formatEpisodeDuration(episode.duration)}</span> : null}
              </div>
            </div>
            <div className={styles.actions}>
              <span className={styles.status} data-status={episode.processingStatus}>
                {getEpisodeStatusLabel(episode.processingStatus, episode.processingSubstatus)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
