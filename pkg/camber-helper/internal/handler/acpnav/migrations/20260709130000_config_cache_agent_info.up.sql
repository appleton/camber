ALTER TABLE acp_config_cache
  ADD COLUMN agent_info_json TEXT NOT NULL DEFAULT 'null';

-- Force a one-time refresh so existing rows pick up agentInfo. This is only a
-- cache: the next session creation re-fetches config options, commands, modes,
-- capabilities and agent info from the agent.
DELETE FROM acp_config_cache;
