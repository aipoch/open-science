import {
  ARTIFACT_MCP_SERVER_ARG,
  NOTEBOOK_MCP_SERVER_ARG,
  PLAN_MCP_SERVER_ARG,
  REVIEWER_MCP_PROXY_ARG,
  SKILL_IMPORT_MCP_SERVER_ARG,
  SKILL_RUNTIME_MCP_SERVER_ARG
} from './mcp-server-args'

export const isRuntimeHelper = (argv: readonly string[]): boolean =>
  [
    ARTIFACT_MCP_SERVER_ARG,
    NOTEBOOK_MCP_SERVER_ARG,
    REVIEWER_MCP_PROXY_ARG,
    SKILL_IMPORT_MCP_SERVER_ARG,
    SKILL_RUNTIME_MCP_SERVER_ARG,
    PLAN_MCP_SERVER_ARG
  ].some((argument) => argv.includes(argument))

export async function runRuntimeHelper(argv: readonly string[]): Promise<boolean> {
  if (argv.includes(ARTIFACT_MCP_SERVER_ARG))
    await (await import('./artifacts/mcp-server')).runArtifactMcpServer()
  else if (argv.includes(NOTEBOOK_MCP_SERVER_ARG))
    await (await import('./notebook/mcp-server')).runNotebookMcpServer()
  else if (argv.includes(REVIEWER_MCP_PROXY_ARG))
    await (await import('./reviewer/mcp-stdio-proxy')).runReviewerMcpStdioProxy()
  else if (argv.includes(SKILL_IMPORT_MCP_SERVER_ARG))
    await (await import('./skills/mcp-server')).runSkillImportMcpServer()
  else if (argv.includes(SKILL_RUNTIME_MCP_SERVER_ARG))
    await (await import('./skills/runtime-mcp-server')).runSkillRuntimeMcpServer()
  else if (argv.includes(PLAN_MCP_SERVER_ARG))
    await (await import('./session-plan/plan-mcp-server')).runPlanMcpServer()
  else return false
  return true
}
