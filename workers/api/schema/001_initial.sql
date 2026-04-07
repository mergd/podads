CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT,
  description TEXT,
  site_link TEXT,
  image_url TEXT,
  author TEXT,
  language TEXT,
  categories_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  last_refreshed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS feeds_normalized_url_idx
  ON feeds(normalized_url);

CREATE UNIQUE INDEX IF NOT EXISTS feeds_url_hash_idx
  ON feeds(url_hash);

CREATE UNIQUE INDEX IF NOT EXISTS feeds_slug_idx
  ON feeds(slug);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  episode_key TEXT NOT NULL,
  guid TEXT,
  title TEXT,
  description TEXT,
  episode_link TEXT,
  author TEXT,
  image_url TEXT,
  pub_date TEXT,
  duration TEXT,
  source_enclosure_url TEXT NOT NULL,
  source_enclosure_type TEXT,
  source_enclosure_length TEXT,
  transcript_key TEXT,
  ad_spans_key TEXT,
  cleaned_enclosure_key TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending',
  processing_version TEXT,
  processing_details_json TEXT NOT NULL DEFAULT '{}',
  last_processed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS episodes_feed_episode_key_idx
  ON episodes(feed_id, episode_key);

CREATE INDEX IF NOT EXISTS episodes_feed_pub_date_idx
  ON episodes(feed_id, pub_date DESC);

CREATE INDEX IF NOT EXISTS episodes_processing_status_idx
  ON episodes(processing_status);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  feed_id INTEGER REFERENCES feeds(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS jobs_status_kind_idx
  ON jobs(status, kind);
