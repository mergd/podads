import { Button, Field, Form, Input } from "@base-ui/react";

import { captureUiEvent } from "../lib/posthog";
import type { RegisterFeedResponse } from "@podads/shared/api";
import styles from "./FeedForm.module.css";

interface FeedFormProps {
  isSubmitting: boolean;
  errorMessage: string | null;
  result: RegisterFeedResponse | null;
  onSubmit: (url: string) => Promise<void>;
}

export function FeedForm({ isSubmitting, errorMessage, result, onSubmit }: FeedFormProps) {
  return (
    <section className={styles.card}>
      <div>
        <div className={styles.eyebrow}>Podcast RSS Proxy</div>
        <h1 className={styles.title}>Paste a feed. Get the same show with fewer ads.</h1>
      </div>
      <p className={styles.lede}>
        Podads keeps one canonical proxy per podcast, preserves the feed metadata, and refreshes registered shows on a
        twice-weekly cadence.
      </p>

      <Form<{ url: string }>
        className={styles.form}
        onFormSubmit={async (values) => {
          const nextUrl = String(values.url ?? "").trim();
          captureUiEvent("feed_submission_started", { url_length: nextUrl.length });
          await onSubmit(nextUrl);
        }}
      >
        <Field.Root
          className={styles.field}
          name="url"
          validate={(value) => {
            const next = String(value ?? "").trim();
            if (!next) {
              return "Paste a podcast RSS URL to continue.";
            }

            try {
              new URL(next);
              return null;
            } catch {
              return "That does not look like a valid URL.";
            }
          }}
        >
          <div className={styles.labelRow}>
            <Field.Label>RSS URL</Field.Label>
            <span className={styles.hint}>One canonical proxy per normalized source feed</span>
          </div>
          <Input className={styles.input} placeholder="https://feeds.example.com/podcast.xml" required />
          <Field.Error className={styles.error} />
        </Field.Root>

        <div className={styles.actions}>
          <Button className={styles.button} disabled={isSubmitting} type="submit">
            {isSubmitting ? "Registering feed..." : "Create proxy feed"}
          </Button>
          {result ? (
            <Button
              className={styles.buttonSecondary}
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(result.proxiedFeedUrl);
                captureUiEvent("proxied_feed_copied", { feed_slug: result.feed.slug });
              }}
            >
              Copy proxied feed URL
            </Button>
          ) : null}
        </div>
      </Form>

      {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}

      {result ? (
        <div className={styles.result}>
          <div className={styles.resultLabel}>Canonical proxied feed</div>
          <div className={styles.resultUrl}>{result.proxiedFeedUrl}</div>
          <div className={styles.statusRow}>
            <span className={styles.badge}>{result.feed.status}</span>
            <span className={styles.resultLabel}>
              {result.created ? "New canonical feed created." : "Existing canonical feed reused."}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
