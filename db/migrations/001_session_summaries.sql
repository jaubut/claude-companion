-- Phase 2: Cold Window Session Summaries Schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id VARCHAR(128) PRIMARY KEY,
  summarized_up_to_turn_id INT NOT NULL,
  summary_markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
