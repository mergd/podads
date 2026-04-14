-- Feed-level ad inference lets us stop auto-transcribing shows after repeated ad-free episodes.
ALTER TABLE feeds ADD COLUMN has_ads INTEGER;

CREATE INDEX IF NOT EXISTS feeds_has_ads_idx
  ON feeds(has_ads);
