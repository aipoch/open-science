import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry'

const CONVENTIONS = [
  'Reach this service ONLY via `host.mcp(server, method, **kwargs)` from the notebook kernel.',
  'Do NOT reimplement these calls with raw HTTP (urllib / requests / httpx / fetch) or hit the upstream endpoints directly — that bypasses the approval gate, per-tool policy, credentials, and rate limits, and can leak project data.',
  'Prefer bulk/list tools over per-item loops — the upstream API is rate-limited and shared across subagents.',
  'Pass large results between cells via `./handoff/*.json`, not the model context.'
].join('\n')

// Renders one connector's tools as a searchable skill document (frontmatter + conventions + methods).
// The frontmatter description is the trigger-style `useWhen` so Claude Code auto-discovers the skill
// from a plain user question, without the user naming the connector.
export function renderSkillDoc(connectorId: string): string {
  const meta = CONNECTOR_CATALOG.find((c) => c.id === connectorId)
  if (!meta) throw new Error(`unknown connector: ${connectorId}`)
  const tools = getConnectorTools(connectorId)
  const header = `---\nname: mcp-${connectorId}\ndescription: ${JSON.stringify(meta.useWhen)}\nsource: connector\n---\n`
  const methods = tools
    .map(
      (t) =>
        `### ${t.id}\n\n${t.description}\n\n\`\`\`json\n${JSON.stringify(t.input, null, 2)}\n\`\`\`\n\n` +
        `Example: \`host.mcp("${connectorId}", "${t.id}", ...)\`\n`
    )
    .join('\n')
  return (
    `${header}\n## When to Use\n\n${meta.useWhen}\n\n` +
    `> This connector is rate-limited at the upstream API.\n\n${CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}

export type CustomSkillDocServer = { name: string; description?: string }
export type CustomSkillDocTool = { name: string; description?: string; inputSchema?: unknown }

// Same shape as renderSkillDoc, but for a user-added custom MCP server: schema comes from
// McpClientManager.listTools() at runtime rather than a bundled descriptor table, and the
// trigger-style description falls back to a composed one when the server has no useWhen text.
export function renderCustomSkillDoc(
  server: CustomSkillDocServer,
  tools: CustomSkillDocTool[]
): string {
  const useWhen =
    server.description ??
    `Use when you need tools from the ${server.name} MCP server — ${tools.map((t) => t.name).join(', ')}.`
  const header = `---\nname: mcp-${server.name}\ndescription: ${JSON.stringify(useWhen)}\nsource: connector\n---\n`
  const methods = tools
    .map(
      (t) =>
        `### ${t.name}\n\n${t.description ?? ''}\n\n\`\`\`json\n${JSON.stringify(t.inputSchema ?? {}, null, 2)}\n\`\`\`\n\n` +
        `Example: \`host.mcp("${server.name}", "${t.name}", ...)\`\n`
    )
    .join('\n')
  return (
    `${header}\n## When to Use\n\n${useWhen}\n\n` +
    `> This connector is rate-limited at the upstream API.\n\n${CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}
