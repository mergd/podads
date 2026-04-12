import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { HtmlContent } from "../components/HtmlContent";
import { Skeleton } from "../components/Skeleton";
import { fetchFeed } from "../lib/api";
import { formatEpisodeDuration, isNewContent, shortDate } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import { captureUiEvent } from "../lib/posthog";
import type { EpisodeSummary, FeedDetailResponse } from "@podads/shared/api";
import styles from "./episode.module.css";

interface EpisodeLinkState {
  title?: string;
  imageUrl?: string | null;
  feedTitle?: string;
}

function findEpisodeById(episodes: EpisodeSummary[], episodeId: number): EpisodeSummary | null {
  return episodes.find((episode) => episode.id === episodeId) ?? null;
}

export function EpisodePage() {
  const { slug = "", episodeId = "" } = useParams();
  const { state } = useLocation() as { state: EpisodeLinkState | null };
  const [detail, setDetail] = useState<FeedDetailResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const parsedEpisodeId = Number.parseInt(episodeId, 10);
  const episode = useMemo(
    () => (detail && Number.isFinite(parsedEpisodeId) ? findEpisodeById(detail.episodes, parsedEpisodeId) : null),
    [detail, parsedEpisodeId]
  );
  const hasAdFreeAudio = Boolean(episode?.cleanedEnclosureUrl);

  useEffect(() => {
    let active = true;

    async function loadEpisode() {
      if (!slug || !Number.isFinite(parsedEpisodeId)) {
        setErrorMessage("That episode could not be found.");
        return;
      }

      try {
        const nextDetail = await fetchFeed(slug);
        if (!active) {
          return;
        }

        const nextEpisode = findEpisodeById(nextDetail.episodes, parsedEpisodeId);

        if (!nextEpisode) {
          setErrorMessage("That episode could not be found.");
          return;
        }

        setDetail(nextDetail);
        setErrorMessage(null);
        captureUiEvent("episode_detail_viewed", {
          feed_slug: slug,
          episode_id: parsedEpisodeId
        });
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load this episode.");
        }
      }
    }

    void loadEpisode();

    return () => {
      active = false;
    };
  }, [parsedEpisodeId, slug]);

  if (errorMessage) {
    return (
      <div className={styles.empty}>
        <p>{errorMessage}</p>
        <Link className={styles.backLink} to={slug ? `/${slug}` : "/"} viewTransition>
          Back
        </Link>
      </div>
    );
  }

  if (!detail || !episode) {
    const previewTitle = state?.title;
    const previewImage = state?.imageUrl;
    const previewFeedTitle = state?.feedTitle;

    return (
      <div className={styles.page}>
        <div className={styles.backRow}>
          {previewFeedTitle ? (
            <Link className={styles.backLink} to={`/${slug}`} viewTransition>
              Back to {previewFeedTitle}
            </Link>
          ) : (
            <Skeleton width={120} height={14} />
          )}
        </div>
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
            {previewFeedTitle ? (
              <div className={styles.eyebrowRow}>
                <Link className={styles.feedLink} to={`/${slug}`} viewTransition>
                  {previewFeedTitle}
                </Link>
              </div>
            ) : (
              <Skeleton width={90} height={10} />
            )}
            {previewTitle ? (
              <h1 className={styles.title} style={{ viewTransitionName: `episode-title-${slug}-${episodeId}` }}>
                {previewTitle}
              </h1>
            ) : (
              <Skeleton width="70%" height={28} style={{ viewTransitionName: `episode-title-${slug}-${episodeId}` }} />
            )}
            <div className={styles.meta}>
              <Skeleton width={70} height={12} />
              <Skeleton width={100} height={12} />
              <Skeleton width={80} height={12} />
            </div>
            <Skeleton width="100%" height={72} />
            <div className={styles.actions}>
              <Skeleton variant="rounded" width={110} height={34} />
              <Skeleton variant="rounded" width={120} height={34} />
              <Skeleton variant="rounded" width={100} height={34} />
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.backRow}>
        <Link className={styles.backLink} to={`/${detail.feed.slug}`} viewTransition>
          Back to {decodeEntities(detail.feed.title)}
        </Link>
      </div>

      <section className={styles.hero}>
        {episode.imageUrl ?? detail.feed.imageUrl ? (
          <img
            alt=""
            className={styles.cover}
            src={episode.imageUrl ?? detail.feed.imageUrl ?? undefined}
            style={{ viewTransitionName: `feed-art-${slug}` }}
          />
        ) : (
          <div className={styles.coverFallback} style={{ viewTransitionName: `feed-art-${slug}` }}>
            {decodeEntities(detail.feed.title ?? "P").charAt(0)}
          </div>
        )}

        <div className={styles.heroContent}>
          <div className={styles.eyebrowRow}>
            <Link className={styles.feedLink} to={`/${detail.feed.slug}`} viewTransition>
              {decodeEntities(detail.feed.title)}
            </Link>
            {isNewContent(episode.pubDate) ? <span className={styles.newBadge}>New</span> : null}
            <Link
              className={styles.reportLink}
              to={`/report?feed=${episode.feedSlug}&episode=${episode.id}`}
              viewTransition
            >
              Report a problem
            </Link>
          </div>

          <h1 className={styles.title} style={{ viewTransitionName: `episode-title-${slug}-${episodeId}` }}>
            {decodeEntities(episode.title)}
          </h1>

          <div className={styles.meta}>
            {episode.pubDate ? <span>{shortDate(episode.pubDate)}</span> : null}
            {episode.duration ? <span>{formatEpisodeDuration(episode.duration)}</span> : null}
            {episode.author ? <span>{episode.author}</span> : null}
          </div>

          <div className={styles.audioState} data-ready={hasAdFreeAudio}>
            {hasAdFreeAudio
              ? "Ad-free audio is ready."
              : "Ad-free audio is still processing. You can play the official episode audio for now."}
          </div>

          {episode.description ? <HtmlContent className={styles.description} html={episode.description} /> : null}

          <div className={styles.actions}>
            <a
              className={styles.primaryButton}
              href={episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl}
              rel="noreferrer"
              target="_blank"
            >
              {hasAdFreeAudio ? "Play ad-free audio" : "Play original audio"}
            </a>
            {episode.episodeLink ? (
              <a className={styles.secondaryButton} href={episode.episodeLink} rel="noreferrer" target="_blank">
                Official Episode Page
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
