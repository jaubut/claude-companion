-- Phase 0/5: Orchestrator Turn Telemetry Schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS orchestrator_turn_metrics (
  turn_id VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(128) NOT NULL,
  route_tier VARCHAR(32) NOT NULL,
  model_id VARCHAR(64) NOT NULL,
  thinking_level VARCHAR(16) NOT NULL,
  injected_skill_count INT NOT NULL,
  prompt_tokens INT NOT NULL,
  cached_prompt_tokens INT NOT NULL DEFAULT 0,
  ttft_ms INT NOT NULL,
  total_latency_ms INT NOT NULL,
  tool_call_count INT NOT NULL DEFAULT 0,
  tool_error_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_session ON orchestrator_turn_metrics(session_id);
