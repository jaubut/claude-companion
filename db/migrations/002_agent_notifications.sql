-- Phase 3: Agent Notifications Surface Bridge Schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS agent_notifications (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(64) NOT NULL,
  severity VARCHAR(16) CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  payload_json JSONB,
  surfaced_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unsurfaced_notifications
ON agent_notifications(severity, created_at)
WHERE surfaced_at IS NULL;
