CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  agent_server TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL
);

INSERT INTO conversations_new (
  id,
  workspace_path,
  agent_server,
  session_id,
  cwd,
  title,
  updated_at,
  active,
  archived,
  created_at,
  touched_at
)
SELECT
  'session:' || agent_server || ':' || session_id,
  workspace_path,
  agent_server,
  session_id,
  cwd,
  title,
  updated_at,
  active,
  archived,
  created_at,
  touched_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;

CREATE INDEX conversations_workspace_active_idx
  ON conversations(workspace_path, active, archived, touched_at);

CREATE UNIQUE INDEX conversations_workspace_session_idx
  ON conversations(workspace_path, agent_server, session_id)
  WHERE session_id IS NOT NULL;
