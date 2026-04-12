import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import { HtmlContent } from "../components/HtmlContent";
import { InlineAudioPlayer } from "../components/InlineAudioPlayer";
import { Skeleton } from "../components/Skeleton";
import { fetchFeed } from "../lib/api";
import { formatEpisodeDuration, isNewContent, shortDate } from "../lib/dates";
import { decodeEntities } from "../lib/entities";
import { captureUiEvent } from "../lib/posthog";
import { getEpisodeAudioStateCopy, getEpisodeStatusLabel, getEpisodeTimeSavedLabel } from "../lib/processing";
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

  const feedTitle = decodeEntities(detail.feed.title);
  const episodeTitle = decodeEntities(episode.title);
  const playbackUrl = episode.cleanedEnclosureUrl ?? episode.sourceEnclosureUrl;
  const playbackLabel = hasAdFreeAudio
    ? `Play ad-free audio for ${episodeTitle}`
    : `Play original audio for ${episodeTitle}`;
  const timeSavedLabel = getEpisodeTimeSavedLabel(
    episode.processingStatus,
    episode.processingDiagnostics,
    hasAdFreeAudio
  );

  return (
    <div className={styles.page}>
      <div className={styles.backRow}>
        <Link className={styles.backLink} to={`/${detail.feed.slug}`} viewTransition>
          Back to {feedTitle}
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
              {feedTitle}
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
            {episodeTitle}
          </h1>

          <div className={styles.meta}>
            {episode.pubDate ? <span>{shortDate(episode.pubDate)}</span> : null}
            {episode.duration ? <span>{formatEpisodeDuration(episode.duration)}</span> : null}
            {episode.author ? <span>{episode.author}</span> : null}
            <span>{getEpisodeStatusLabel(episode.processingStatus, episode.processingSubstatus)}</span>
          </div>

          <div className={styles.audioState} data-ready={hasAdFreeAudio}>
            {getEpisodeAudioStateCopy(episode.processingStatus, episode.processingSubstatus, hasAdFreeAudio)}
          </div>
          {timeSavedLabel ? (
            <div
              className={styles.timeSaved}
              data-positive={(episode.processingDiagnostics?.removedDurationMs ?? 0) > 0}
            >
              {timeSavedLabel}
            </div>
          ) : null}

          {episode.description ? <HtmlContent className={styles.description} html={episode.description} /> : null}

          <div className={styles.actions}>
            <InlineAudioPlayer
              buttonText={hasAdFreeAudio ? "Play ad-free audio" : "Play original audio"}
              className={styles.audioPlayer}
              label={playbackLabel}
              src={playbackUrl}
              type={episode.sourceEnclosureType}
            />
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
