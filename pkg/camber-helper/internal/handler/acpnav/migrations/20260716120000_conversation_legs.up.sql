CREATE TABLE conversation_legs (
  handoff_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  agent_server TEXT NOT NULL,
  session_id TEXT NOT NULL,
  target_agent_server TEXT NOT NULL,
  target_session_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  events_json TEXT NOT NULL,
  turns_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX conversation_legs_conversation_idx
  ON conversation_legs(conversation_id, committed, ordinal);

CREATE UNIQUE INDEX conversation_legs_committed_source_idx
  ON conversation_legs(conversation_id, agent_server, session_id)
  WHERE committed = 1;
