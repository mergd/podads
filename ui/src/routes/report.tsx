import { Button, Field, Form, Input } from "@base-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Skeleton } from "../components/Skeleton";
import { fetchFeed, submitComplaint } from "../lib/api";
import { decodeEntities } from "../lib/entities";
import { captureUiEvent } from "../lib/posthog";
import type { ComplaintRequest, FeedDetailResponse } from "@podads/shared/api";
import styles from "./report.module.css";

interface ComplaintValues {
  email: string;
  issueType: ComplaintRequest["issueType"];
  message: string;
}

export function ReportPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedDetailResponse | null>(null);

  const context = useMemo(
    () => ({
      feedSlug: searchParams.get("feed") ?? undefined,
      episodeId: searchParams.get("episode") ? Number(searchParams.get("episode")) : undefined
    }),
    [searchParams]
  );

  useEffect(() => {
    const feedSlug = context.feedSlug;
    if (!feedSlug) return;

    let active = true;

    async function load() {
      try {
        const next = await fetchFeed(feedSlug);
        if (active) setDetail(next);
      } catch {
        // feed context is optional, don't block the form
      }
    }

    void load();
    return () => { active = false; };
  }, [context.feedSlug]);

  const episode = detail?.episodes.find((ep) => ep.id === context.episodeId);

  if (!context.feedSlug) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Report an issue</h1>
          <p className={styles.lede}>
            To report a problem, navigate to a show and use the report link on a specific episode.
          </p>
        </div>
        <Link className={styles.backLink} to="/" viewTransition>Browse shows</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {detail ? (
        <div className={styles.showContext}>
          {detail.feed.imageUrl ? (
            <img
              alt=""
              className={styles.showArt}
              src={detail.feed.imageUrl}
              style={{ viewTransitionName: `feed-art-${detail.feed.slug}` }}
            />
          ) : (
            <div
              className={styles.showArtFallback}
              style={{ viewTransitionName: `feed-art-${detail.feed.slug}` }}
            >
              {decodeEntities(detail.feed.title ?? "P").charAt(0)}
            </div>
          )}
          <div className={styles.showInfo}>
            <Link
              className={styles.showName}
              style={{ viewTransitionName: `feed-title-${detail.feed.slug}` }}
              to={`/${detail.feed.slug}`}
              viewTransition
            >
              {decodeEntities(detail.feed.title)}
            </Link>
            {episode ? (
              <div className={styles.episodeInfo}>
                <span className={styles.episodeLabel}>Episode:</span>
                <span>{decodeEntities(episode.title)}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : context.feedSlug ? (
        <div className={styles.showContext}>
          <Skeleton variant="rounded" width="3rem" height="3rem" style={{ viewTransitionName: `feed-art-${context.feedSlug}` }} />
          <div className={styles.showInfo}>
            <Skeleton width="40%" height={14} style={{ viewTransitionName: `feed-title-${context.feedSlug}` }} />
            {context.episodeId ? <Skeleton width="60%" height={10} /> : null}
          </div>
        </div>
      ) : null}

      <div className={styles.header}>
        <h1 className={styles.title}>Report an issue</h1>
        <p className={styles.lede}>
          Bad cut, missed ad, or wrong metadata on this {episode ? "episode" : "show"}? Let us know.
        </p>
      </div>

      <Form<ComplaintValues>
        className={styles.form}
        onFormSubmit={async (values) => {
          setStatus(null);
          setErrorMessage(null);

          try {
            await submitComplaint({
              feedSlug: context.feedSlug,
              episodeId: context.episodeId,
              email: String(values.email ?? "").trim() || undefined,
              issueType: values.issueType,
              message: String(values.message ?? "").trim()
            });
            setStatus("Thanks — complaint captured and ready for analysis.");
            captureUiEvent("complaint_submitted", {
              feed_slug: context.feedSlug ?? null,
              episode_id: context.episodeId ?? null,
              issue_type: values.issueType
            });
          } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "Could not submit this complaint.");
          }
        }}
      >
        <Field.Root className={styles.field} name="email">
          <Field.Label className={styles.label}>Email (optional)</Field.Label>
          <Input className={styles.input} placeholder="you@example.com" type="email" />
        </Field.Root>

        <Field.Root className={styles.field} name="issueType">
          <Field.Label className={styles.label}>Issue type</Field.Label>
          <select className={styles.select} defaultValue="bad_cut" name="issueType">
            <option value="bad_cut">Bad cut</option>
            <option value="missed_ad">Missed ad</option>
            <option value="metadata_issue">Metadata issue</option>
            <option value="other">Other</option>
          </select>
        </Field.Root>

        <Field.Root className={styles.field} name="message">
          <Field.Label className={styles.label}>What happened?</Field.Label>
          <textarea
            className={styles.textarea}
            name="message"
            placeholder="Describe what the proxy missed or cut incorrectly."
            required
            rows={5}
          />
        </Field.Root>

        <Button className={styles.button} type="submit">
          Send report
        </Button>
      </Form>

      {status ? <div className={styles.success}>{status}</div> : null}
      {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}
    </div>
  );
}
