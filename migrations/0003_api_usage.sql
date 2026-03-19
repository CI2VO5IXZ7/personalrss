-- API 调用量统计表

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- YYYY-MM-DD (UTC+8)
  endpoint TEXT NOT NULL,          -- API 端点名称
  calls INTEGER DEFAULT 0,
  UNIQUE(date, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(date DESC);
