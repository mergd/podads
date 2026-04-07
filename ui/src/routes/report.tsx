import { Button, Field, Form, Input } from "@base-ui/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { submitComplaint } from "../lib/api";
import { captureUiEvent } from "../lib/posthog";
import type { ComplaintRequest } from "../types/api";
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

  const context = useMemo(
    () => ({
      feedSlug: searchParams.get("feed") ?? undefined,
      episodeId: searchParams.get("episode") ? Number(searchParams.get("episode")) : undefined
    }),
    [searchParams]
  );

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <div>
          <h1 className={styles.title}>Report an issue</h1>
          <p className={styles.lede}>
            If the proxy missed an ad, cut too aggressively, or preserved the wrong metadata, send the context here.
          </p>
        </div>

        <div className={styles.context}>
          <span>Feed: {context.feedSlug ?? "Unknown"}</span>
          <span>Episode: {context.episodeId ?? "Not specified"}</span>
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
              setStatus("Thanks. The complaint was captured and is ready for analysis.");
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

          <label className={styles.field}>
            <span className={styles.label}>Issue type</span>
            <select className={styles.select} defaultValue="bad_cut" name="issueType">
              <option value="bad_cut">Bad cut</option>
              <option value="missed_ad">Missed ad</option>
              <option value="metadata_issue">Metadata issue</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>What happened?</span>
            <textarea
              className={styles.textarea}
              name="message"
              placeholder="Tell us what the proxy missed or cut incorrectly."
              required
            />
          </label>

          <Button className={styles.button} type="submit">
            Send complaint
          </Button>
        </Form>

        {status ? <div className={styles.status}>{status}</div> : null}
        {errorMessage ? <div className={styles.error}>{errorMessage}</div> : null}
      </section>
    </div>
  );
}
