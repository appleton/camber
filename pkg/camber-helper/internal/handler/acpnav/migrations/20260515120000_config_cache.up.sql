CREATE TABLE acp_config_cache (
  agent_server TEXT PRIMARY KEY,
  config_options_json TEXT NOT NULL DEFAULT '[]',
  modes_json TEXT NOT NULL DEFAULT 'null',
  available_commands_json TEXT NOT NULL DEFAULT '[]',
  cached_at TEXT NOT NULL
);
