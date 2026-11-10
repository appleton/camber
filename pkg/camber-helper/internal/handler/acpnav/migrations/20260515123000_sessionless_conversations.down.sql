CREATE TABLE conversations_old (
  workspace_path TEXT NOT NULL,
  agent_server TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL,
  PRIMARY KEY (workspace_path, agent_server, session_id)
);

INSERT INTO conversations_old (
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
  workspace_path,
  agent_server,
  COALESCE(session_id, id),
  cwd,
  title,
  updated_at,
  active,
  archived,
  created_at,
  touched_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_old RENAME TO conversations;

CREATE INDEX conversations_workspace_active_idx
  ON conversations(workspace_path, active, archived, touched_at);
