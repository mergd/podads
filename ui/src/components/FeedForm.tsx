import { useEffect, useState } from "react";

import { Button, Field, Form, Input } from "@base-ui/react";

import { lookupFeed, previewFeed } from "../lib/api";
import { decodeEntities } from "../lib/entities";
import { captureUiEvent } from "../lib/posthog";
import { FeedPreviewDialog } from "./FeedPreviewDialog";
import type { FeedLookupResponse, FeedPreviewResponse, RegisterFeedResponse } from "@podads/shared/api";
import styles from "./FeedForm.module.css";

interface FeedFormProps {
  isSubmitting: boolean;
  errorMessage: string | null;
  result: RegisterFeedResponse | null;
  onSubmit: (url: string) => Promise<void>;
  onDraftChange: () => void;
}

function getUrlValidationMessage(value: string): string | null {
  const next = value.trim();
  if (!next) {
    return "Paste a podcast RSS URL to continue.";
  }

  try {
    new URL(next);
    return null;
  } catch {
    return "That doesn't look like a valid URL.";
  }
}

export function FeedForm({ isSubmitting, errorMessage, result, onSubmit, onDraftChange }: FeedFormProps) {
  const [url, setUrl] = useState("");
  const [lookup, setLookup] = useState<FeedLookupResponse | null>(null);
  const [preview, setPreview] = useState<FeedPreviewResponse | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    const trimmedUrl = url.trim();

    if (!trimmedUrl || getUrlValidationMessage(trimmedUrl)) {
      setLookup(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void lookupFeed(trimmedUrl)
        .then((nextLookup) => {
          if (!cancelled) {
            setLookup(nextLookup);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLookup(null);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [url]);

  async function handleOpenPreview(): Promise<void> {
    const trimmedUrl = url.trim();
    const validationMessage = getUrlValidationMessage(trimmedUrl);

    if (validationMessage) {
      setPreviewError(validationMessage);
      return;
    }

    setPreview(null);
    setPreviewError(null);
    setIsPreviewOpen(true);
    setIsPreviewLoading(true);

    try {
      const nextPreview = await previewFeed(trimmedUrl);
      setPreview(nextPreview);
      captureUiEvent("feed_preview_loaded", {
        existing_feed: nextPreview.exists,
        episode_count: nextPreview.episodeCount
      });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Could not preview that feed.");
    } finally {
      setIsPreviewLoading(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    const trimmedUrl = url.trim();
    await onSubmit(trimmedUrl);
    setIsPreviewOpen(false);
  }

  return (
    <div className={styles.root}>
      <Form<{ url: string }>
        className={styles.form}
        onFormSubmit={async () => {
          if (lookup?.exists) return;
          captureUiEvent("feed_preview_requested", {
            existing_feed_hint: false,
            url_length: url.trim().length
          });
          await handleOpenPreview();
        }}
      >
        <Field.Root
          className={styles.field}
          name="url"
          validate={(value) => getUrlValidationMessage(String(value ?? ""))}
        >
          <div className={styles.inputRow}>
            <Input
              className={styles.input}
              placeholder="https://feeds.example.com/podcast.xml"
              onChange={(event) => {
                setUrl(event.target.value);
                setPreview(null);
                setPreviewError(null);
                onDraftChange();
              }}
              value={url}
              required
            />
            <Button className={styles.button} disabled={isSubmitting || Boolean(lookup?.exists)} type="submit">
              Preview ad-free feed
            </Button>
          </div>
          <Field.Error className={styles.error} />
        </Field.Root>

        {lookup?.match ? (
          <div className={styles.lookupHint}>
            This feed already has an ad-free version.{" "}
            <a className={styles.lookupLink} href={`/feeds/${lookup.match.feed.slug}`}>
              View {decodeEntities(lookup.match.feed.title)}
            </a>
          </div>
        ) : null}
      </Form>

      {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}

      {result ? (
        <div className={styles.result}>
          <div className={styles.resultRow}>
            <span className={styles.badge}>{result.created ? "New" : "Existing"}</span>
            <code className={styles.resultUrl}>{result.proxiedFeedUrl}</code>
          </div>
          <Button
            className={styles.copyButton}
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(result.proxiedFeedUrl);
              captureUiEvent("proxied_feed_copied", { feed_slug: result.feed.slug });
            }}
          >
            Copy URL
          </Button>
        </div>
      ) : null}

      <FeedPreviewDialog
        errorMessage={previewError}
        isLoading={isPreviewLoading}
        isSubmitting={isSubmitting}
        onClose={() => {
          if (isSubmitting) {
            return;
          }

          setIsPreviewOpen(false);
        }}
        onConfirm={async () => {
          captureUiEvent("feed_submission_started", {
            existing_feed: Boolean(preview?.exists),
            url_length: url.trim().length
          });
          await handleConfirm();
        }}
        open={isPreviewOpen}
        preview={preview}
      />
    </div>
  );
}
