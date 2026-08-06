// Process-argv flags that switch the main entry into a Node stdio MCP server mode instead of the
// Electron UI. Kept in their own dependency-free module so index.ts can detect the mode from argv
// WITHOUT statically importing the MCP server modules (and their heavy SDK graph) — those are imported
// lazily, only once the flag matches, so the UI path acquires the single-instance lock before any
// backend module loads.
export const ARTIFACT_MCP_SERVER_ARG = '--open-science-artifact-mcp'
export const NOTEBOOK_MCP_SERVER_ARG = '--open-science-notebook-mcp'
export const REVIEWER_MCP_PROXY_ARG = '--open-science-reviewer-mcp-proxy'
export const SKILL_IMPORT_MCP_SERVER_ARG = '--open-science-skill-import-mcp'
export const PLAN_MCP_SERVER_ARG = '--open-science-plan-mcp'
