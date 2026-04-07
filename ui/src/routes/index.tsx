import { useEffect, useState } from "react";

import { FeedForm } from "../components/FeedForm";
import { FeedGallery } from "../components/FeedGallery";
import { LatestEpisodes } from "../components/LatestEpisodes";
import { fetchHome, registerFeed } from "../lib/api";
import { captureUiEvent } from "../lib/posthog";
import type { HomeResponse, RegisterFeedResponse } from "../types/api";
import styles from "./index.module.css";

export function HomePage() {
  const [home, setHome] = useState<HomeResponse>({ latestEpisodes: [], feeds: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RegisterFeedResponse | null>(null);

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
      setHome(await fetchHome());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not register that feed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <FeedForm errorMessage={errorMessage} isSubmitting={isSubmitting} result={result} onSubmit={handleSubmit} />

      {isLoading ? <div>Loading homepage activity...</div> : null}

      <div className={styles.grid}>
        <LatestEpisodes episodes={home.latestEpisodes} />
        <FeedGallery feeds={home.feeds} />
      </div>
    </div>
  );
}
