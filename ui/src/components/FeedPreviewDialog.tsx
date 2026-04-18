import { Button } from "@base-ui/react";

import { BrandCorner } from "./BrandCorner";
import { HtmlContent } from "./HtmlContent";
import { decodeEntities } from "../lib/entities";
import { formatEpisodeDuration, isNewContent, shortDate } from "../lib/dates";
import type { FeedPreviewResponse } from "@podads/shared/api";
import styles from "./FeedPreviewDialog.module.css";

interface FeedPreviewDialogProps {
  open: boolean;
  preview: FeedPreviewResponse | null;
  isLoading: boolean;
  isSubmitting: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function FeedPreviewDialog({
  open,
  preview,
  isLoading,
  isSubmitting,
  errorMessage,
  onClose,
  onConfirm
}: FeedPreviewDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div aria-modal="true" className={styles.backdrop} role="dialog">
      <div className={styles.dialog}>
        <button aria-label="Close preview" className={styles.closeButton} onClick={onClose} type="button">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        {isLoading ? (
          <div className={styles.loading}>Fetching the latest feed metadata and episodes...</div>
        ) : errorMessage ? (
          <div className={styles.error}>{errorMessage}</div>
        ) : preview ? (
          <div className={styles.columns}>
            <div className={styles.detailCol}>
              <div className={styles.detailInner}>
                {preview.imageUrl ? (
                  <div className={styles.artWrap}>
                    <img alt="" className={styles.art} src={preview.imageUrl} />
                    <BrandCorner src={preview.imageUrl} />
                  </div>
                ) : (
                  <div className={styles.artPlaceholder} />
                )}
                <h2 className={styles.title}>{decodeEntities(preview.title)}</h2>
                <span className={styles.metaText}>{preview.episodeCount} episodes</span>
                {preview.author ? <p className={styles.author}>By {preview.author}</p> : null}
                {preview.description ? (
                  <HtmlContent className={styles.description} html={preview.description} />
                ) : null}
              </div>

              <div className={styles.actions}>
                <Button className={styles.secondaryButton} onClick={onClose} type="button">
                  Cancel
                </Button>
                <Button
                  className={styles.primaryButton}
                  disabled={isSubmitting}
                  onClick={() => { void onConfirm(); }}
                  type="button"
                >
                  {isSubmitting ? "Creating..." : "Create ad-free feed"}
                </Button>
              </div>
            </div>

            <div className={styles.episodeCol}>
              <h3 className={styles.sectionTitle}>Episode preview</h3>
              <div className={styles.episodeList}>
                {preview.episodes.map((episode) => (
                  <article className={styles.episode} key={`${episode.title}-${episode.pubDate ?? "unknown"}`}>
                    {episode.imageUrl ? (
                      <img alt="" className={styles.episodeArt} src={episode.imageUrl} />
                    ) : null}
                    <div className={styles.episodeBody}>
                      <div className={styles.episodeTitleRow}>
                        <h4 className={styles.episodeTitle}>{decodeEntities(episode.title)}</h4>
                        {isNewContent(episode.pubDate) ? <span className={styles.newBadge}>New</span> : null}
                      </div>
                      <div className={styles.episodeMeta}>
                        {episode.pubDate ? <span>{shortDate(episode.pubDate)}</span> : null}
                        {episode.duration ? <span>{formatEpisodeDuration(episode.duration)}</span> : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {preview && !isLoading && !errorMessage ? (
          <div className={styles.mobileActions}>
            <Button className={styles.secondaryButton} onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              className={styles.primaryButton}
              disabled={isSubmitting}
              onClick={() => { void onConfirm(); }}
              type="button"
            >
              {isSubmitting ? "Creating..." : "Create ad-free feed"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
