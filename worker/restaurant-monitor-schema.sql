-- Isoliertes Schema für die spätere Website-Überwachung.
-- Wird NICHT automatisch ausgeführt; keine Live-Datenbankänderung.

CREATE TABLE IF NOT EXISTS restaurant_site_snapshots (
  restaurant_id TEXT NOT NULL,
  page_url TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  extracted_data_json TEXT NOT NULL DEFAULT '{}',
  content_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (restaurant_id, page_url)
);

CREATE TABLE IF NOT EXISTS restaurant_change_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_at TEXT NOT NULL DEFAULT '',
    notified_at TEXT NOT NULL DEFAULT '',
  UNIQUE (restaurant_id, field_name, old_value, new_value)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_change_proposals_status
  ON restaurant_change_proposals(status, detected_at);
