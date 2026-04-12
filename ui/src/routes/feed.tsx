import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { HtmlContent } from "../components/HtmlContent";
import { InlineAudioPlayer } from "../components/InlineAudioPlayer";
import { Skeleton } from "../components/Skeleton";
import { SubscribeButtons } from "../components/SubscribeButtons";
import { formatEpisodeDuration, isNewContent, lastUpdatedLabel, shortDate } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import { fetchFeed } from "../lib/api";
import { captureUiEvent } from "../lib/posthog";
import { getEpisodeStatusLabel, getEpisodeTimeSavedLabel } from "../lib/processing";
import type { FeedDetailResponse } from "@podads/shared/api";
import styles from "./feed.module.css";

interface FeedLinkState {
  title?: string;
  imageUrl?: string | null;
}

export function FeedPage() {
  const { slug = "" } = useParams();
  const { state } = useLocation() as { state: FeedLinkState | null };
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
    return (
      <div className={styles.empty}>
        <p>{errorMessage}</p>
        <Link className={styles.backLink} to="/" viewTransition>Back to home</Link>
      </div>
    );
  }

  if (!detail) {
    const previewTitle = state?.title;
    const previewImage = state?.imageUrl;

    return (
      <div className={styles.page}>
        <section className={styles.hero}>
          {previewImage ? (
            <img
              alt=""
              className={styles.cover}
              src={previewImage}
              style={{ viewTransitionName: `feed-art-${slug}` }}
            />
          ) : (
            <Skeleton variant="rounded" width="7rem" height="7rem" style={{ viewTransitionName: `feed-art-${slug}` }} />
          )}
          <div className={styles.heroContent}>
            <div className={styles.eyebrowRow}>
              <div className={styles.eyebrow}>Proxied feed</div>
              <Link className={styles.reportLink} to={`/report?feed=${slug}`} viewTransition>
                Report a problem
              </Link>
            </div>
            {previewTitle ? (
              <h1 className={styles.title} style={{ viewTransitionName: `feed-title-${slug}` }}>{previewTitle}</h1>
            ) : (
              <Skeleton width="60%" height={24} style={{ viewTransitionName: `feed-title-${slug}` }} />
            )}
            <Skeleton width="90%" height={14} />
            <div className={styles.stats}>
              <Skeleton width={70} height={12} />
              <Skeleton width={90} height={12} />
            </div>
            <Skeleton variant="rounded" width={180} height={34} />
          </div>
        </section>
        <section className={styles.episodes}>
          <h2 className={styles.sectionTitle}>Episodes</h2>
          <div className={styles.list}>
            {Array.from({ length: 5 }, (_, i) => (
              <div className={styles.skeletonEpisode} key={i}>
                <div className={styles.episodeContent}>
                  <Skeleton width="70%" height={16} />
                  <Skeleton width="40%" height={10} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        {detail.feed.imageUrl ? (
          <img
            alt=""
            className={styles.cover}
            src={detail.feed.imageUrl}
            style={{ viewTransitionName: `feed-art-${slug}` }}
          />
        ) : (
          <div className={styles.coverFallback} style={{ viewTransitionName: `feed-art-${slug}` }}>
            {decodeEntities(detail.feed.title ?? "P").charAt(0)}
          </div>
        )}
        <div className={styles.heroContent}>
          <div className={styles.eyebrowRow}>
            <div className={styles.eyebrow}>Proxied feed</div>
            <Link className={styles.reportLink} to={`/report?feed=${detail.feed.slug}`} viewTransition>
              Report a problem
            </Link>
          </div>
          <h1 className={styles.title} style={{ viewTransitionName: `feed-title-${slug}` }}>{decodeEntities(detail.feed.title)}</h1>
          {detail.feed.description ? (
            <HtmlContent className={styles.description} html={detail.feed.description} />
          ) : null}
          <div className={styles.stats}>
            <span>{detail.feed.episodeCount} episode{detail.feed.episodeCount !== 1 ? "s" : ""}</span>
            {detail.feed.latestEpisodePubDate ? (
              <span>{lastUpdatedLabel(detail.feed.latestEpisodePubDate)}</span>
            ) : null}
          </div>
          <SubscribeButtons feedUrl={detail.proxiedFeedUrl} />
        </div>
      </section>

      {detail.episodes.length > 0 ? (
        <section className={styles.episodes}>
          <h2 className={styles.sectionTitle}>
            Episodes
            <span className={styles.count}>{detail.episodes.length}</span>
          </h2>
          <div className={styles.list}>
            {detail.episodes.map((episode) => {
              const episodeTitle = decodeEntities(episode.title);
              const playbackUrl = episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl;
              const timeSavedLabel = getEpisodeTimeSavedLabel(
                episode.processingStatus,
                episode.processingDiagnostics,
                Boolean(episode.cleanedEnclosureUrl)
              );

              return (
                <article className={styles.episode} key={episode.id}>
                  {episode.imageUrl ? (
                    <div className={styles.episodeArtWrap}>
                      <img alt="" className={styles.episodeArt} loading="lazy" src={episode.imageUrl} />
                    </div>
                  ) : null}
                  <div className={styles.episodeContent}>
                    <div className={styles.episodeTitleRow}>
                      <Link className={styles.episodeTitleLink} state={{ title: episode.title, imageUrl: episode.imageUrl ?? detail.feed.imageUrl, feedTitle: detail.feed.title }} to={`/${episode.feedSlug}/episodes/${episode.id}`} viewTransition>
                        <h3
                          className={styles.episodeName}
                          style={{ viewTransitionName: `episode-title-${episode.feedSlug}-${episode.id}` }}
                        >
                          {episodeTitle}
                        </h3>
                      </Link>
                      {isNewContent(episode.pubDate) ? <span className={styles.newBadge}>New</span> : null}
                    </div>
                    <div className={styles.episodeMeta}>
                      <span className={styles.status} data-status={episode.processingStatus}>
                        {getEpisodeStatusLabel(episode.processingStatus, episode.processingSubstatus)}
                      </span>
                      {timeSavedLabel ? (
                        <span
                          className={styles.timeSaved}
                          data-positive={(episode.processingDiagnostics?.removedDurationMs ?? 0) > 0}
                        >
                          {timeSavedLabel}
                        </span>
                      ) : null}
                      {episode.pubDate ? <span>{shortDate(episode.pubDate)}</span> : null}
                      {episode.duration ? <span>{formatEpisodeDuration(episode.duration)}</span> : null}
                    </div>
                    {episode.description ? (
                      <HtmlContent className={styles.episodeDesc} html={episode.description} />
                    ) : null}
                    <InlineAudioPlayer
                      className={styles.inlinePlayer}
                      label={`Play ${episodeTitle}`}
                      src={playbackUrl}
                      type={episode.sourceEnclosureType}
                    />
                  </div>
                  <div className={styles.episodeActions}>
                    {episode.episodeLink ? (
                      <a className={styles.link} href={episode.episodeLink} rel="noreferrer" target="_blank">
                        Episode page
                      </a>
                    ) : null}
                    <Link className={styles.link} to={`/report?feed=${episode.feedSlug}&episode=${episode.id}`} viewTransition>
                      Report
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
