CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('GET', 'POST')),
  url TEXT NOT NULL,
  parameterized INTEGER NOT NULL DEFAULT 0,
  headers TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_webhooks (
  space_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  PRIMARY KEY (space_id, webhook_id),
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
