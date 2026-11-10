CREATE TABLE projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  parent_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(parent_path) REFERENCES projects(path) ON DELETE SET NULL
);

CREATE TABLE conversations (
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

CREATE INDEX conversations_workspace_active_idx
  ON conversations(workspace_path, active, archived, touched_at);
