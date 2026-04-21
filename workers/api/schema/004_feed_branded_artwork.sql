-- Store a podads-branded version of each feed's artwork (source image + P corner badge)
-- so podcast clients like Apple Podcasts display our logo, not just the publisher's raw artwork.
ALTER TABLE feeds ADD COLUMN branded_image_key TEXT;
ALTER TABLE feeds ADD COLUMN branded_image_source_url TEXT;
ALTER TABLE feeds ADD COLUMN branded_image_updated_at TEXT;
