ALTER TABLE acp_config_cache
  ADD COLUMN prompt_capabilities_json TEXT NOT NULL DEFAULT 'null';

-- Force a one-time refresh so existing rows pick up promptCapabilities. This is
-- only a cache: the next session creation re-fetches config options, commands,
-- modes and capabilities from the agent. Agent-server defaults (including
-- default config options) live in the separate acp_agent_servers table and are
-- intentionally left untouched.
DELETE FROM acp_config_cache;
