import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { FeedForm } from "../components/FeedForm";
import { FeedGallery } from "../components/FeedGallery";
import { LatestEpisodes } from "../components/LatestEpisodes";
import { Skeleton } from "../components/Skeleton";
import { fetchHome, registerFeed } from "../lib/api";
import { captureUiEvent } from "../lib/posthog";
import type { HomeResponse, RegisterFeedResponse } from "@podads/shared/api";
import styles from "./index.module.css";

export function HomePage() {
  const [home, setHome] = useState<HomeResponse>({ latestEpisodes: [], feeds: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterFeedResponse | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    async function loadHome() {
      try {
        const nextHome = await fetchHome();
        if (active) {
          setHome(nextHome);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load the homepage feed data.");
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadHome();

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(url: string) {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const nextResult = await registerFeed(url);
      setResult(nextResult);
      captureUiEvent("feed_submission_completed", {
        feed_slug: nextResult.feed.slug,
        created: nextResult.created
      });
      navigate(`/${nextResult.feed.slug}`, {
        state: { title: nextResult.feed.title, imageUrl: nextResult.feed.imageUrl },
        viewTransition: true
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not register that feed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.headline}>
          Same show, fewer ads.
        </h1>
        <p className={styles.sub}>
          Paste any podcast RSS feed and get a clean proxy — ads detected and stripped automatically.
        </p>
        <FeedForm
          errorMessage={errorMessage}
          isSubmitting={isSubmitting}
          onDraftChange={() => {
            setErrorMessage(null);
            setResult(null);
          }}
          onSubmit={handleSubmit}
          result={result}
        />
      </section>

      {isLoading ? (
        <>
          <section className={styles.skeletonSection}>
            <Skeleton width={80} height={22} />
            <div className={styles.skeletonGrid}>
              {Array.from({ length: 6 }, (_, i) => (
                <div className={styles.skeletonCard} key={i}>
                  <Skeleton variant="rounded" width="100%" height={0} className={styles.skeletonArt} />
                  <Skeleton width="80%" height={14} />
                  <Skeleton width="50%" height={10} />
                </div>
              ))}
            </div>
          </section>
          <section className={styles.skeletonSection}>
            <Skeleton width={120} height={22} />
            <div className={styles.skeletonList}>
              {Array.from({ length: 4 }, (_, i) => (
                <div className={styles.skeletonRow} key={i}>
                  <Skeleton variant="rounded" width="2.4rem" height="2.4rem" />
                  <div className={styles.skeletonRowContent}>
                    <Skeleton width="30%" height={10} />
                    <Skeleton width="60%" height={14} />
                    <Skeleton width="20%" height={10} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <>
          {home.feeds.length > 0 && <FeedGallery feeds={home.feeds} />}
          {home.latestEpisodes.length > 0 && <LatestEpisodes episodes={home.latestEpisodes} />}
        </>
      )}
    </div>
  );
}
