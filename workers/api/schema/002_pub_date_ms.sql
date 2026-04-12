-- Chronological ordering for processing/skip selection (RFC822 pub_date strings sort incorrectly as TEXT).
ALTER TABLE episodes ADD COLUMN pub_date_ms INTEGER;

CREATE INDEX IF NOT EXISTS episodes_feed_pub_date_ms_idx
  ON episodes(feed_id, pub_date_ms DESC);
