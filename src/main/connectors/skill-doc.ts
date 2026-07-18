import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry'

const CONVENTIONS = [
  'Reach this service ONLY via `host.mcp` from the notebook kernel. It runs synchronously and returns the result directly — assign it: `result = host.mcp(server, method, {...})`. Arguments go as a dict, or as keywords (`host.mcp(server, method, term=...)`).',
  "The result is a ready-to-use native Python value — a dict or list for most tools, sometimes a string or number. It is already parsed (not a JSON string). Each tool's **Returns** block gives its exact shape and field meanings; how you inspect or process it is up to you.",
  'The notebook kernel is a persistent shared session: the variable you assign a result to stays available in later cells, so reuse it instead of running the call again. Each call hits the rate-limited upstream — never re-issue the same call to look at or reprocess a result you already have.',
  'Do NOT reimplement these calls with raw HTTP (urllib / requests / httpx / fetch) or hit the upstream endpoints directly — that bypasses the approval gate, per-tool policy, credentials, and rate limits, and can leak project data.',
  'Prefer bulk/list tools over per-item loops — the upstream API is rate-limited and shared across subagents.',
  'Pass large results between cells via `./handoff/*.json`, not the model context.'
].join('\n')

// Placeholder value for one JSON-Schema field in a call example: an enum's first choice or the field's
// own default when present, otherwise a type-keyed stand-in. Rendered as a JSON literal.
function sampleValue(spec: { type?: unknown; default?: unknown; enum?: unknown }): string {
  if (Array.isArray(spec.enum) && spec.enum.length) return JSON.stringify(spec.enum[0])
  if ('default' in spec) return JSON.stringify(spec.default)
  switch (spec.type) {
    case 'integer':
    case 'number':
      return '0'
    case 'boolean':
      return 'false'
    case 'array':
      return '[]'
    case 'object':
      return '{}'
    default:
      return '"..."'
  }
}

// Builds a compact, copyable sample-args dict from a tool's JSON Schema: the required fields plus any
// field that declares a default, so the example shows the real argument names and call shape without
// inventing data. Returns undefined when the schema exposes no such fields, so callers fall back to a
// generic `...` (e.g. a custom tool that ships only `{ "type": "object" }` or no schema at all).
function exampleArgs(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return undefined
  const requiredList = (schema as { required?: unknown }).required
  const required = new Set(
    Array.isArray(requiredList)
      ? requiredList.filter((r): r is string => typeof r === 'string')
      : []
  )
  const entries: string[] = []
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    const spec = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      type?: unknown
      default?: unknown
      enum?: unknown
    }
    if (!required.has(key) && !('default' in spec)) continue
    entries.push(`"${key}": ${sampleValue(spec)}`)
  }
  return entries.length ? `{${entries.join(', ')}}` : undefined
}

// Renders one tool's usage example as a copyable python cell. Prefers the descriptor's hand-authored
// `example` (a single call with realistic args); otherwise builds a bare call from the schema. A tool
// with no concrete args renders as `host.mcp(server, method)` (no third argument) — passing a literal
// `...` there would reach the bridge as Ellipsis and raise, so it must be omitted.
function renderExample(server: string, tool: string, schema: unknown, example?: string): string {
  if (example) return `Example:\n\n\`\`\`python\n${example}\n\`\`\`\n`
  const args = exampleArgs(schema)
  const call = args
    ? `host.mcp("${server}", "${tool}", ${args})`
    : `host.mcp("${server}", "${tool}")`
  return `Example:\n\n\`\`\`python\nresult = ${call}\n\`\`\`\n`
}

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
        (t.returns ? `**Returns:** ${t.returns}\n\n` : '') +
        renderExample(connectorId, t.id, t.input, t.example)
    )
    .join('\n')
  return (
    `${header}\n## When to Use\n\n${meta.useWhen}\n\n` +
    `> This connector is rate-limited at the upstream API.\n\n${CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}

export type CustomSkillDocServer = { id: string; name: string; description?: string }
export type CustomSkillDocTool = { name: string; description?: string; inputSchema?: unknown }

// Same shape as renderSkillDoc, but for a user-added custom MCP server: schema comes from
// McpClientManager.listTools() at runtime rather than a bundled descriptor table, and the
// trigger-style description falls back to a composed one when the server has no useWhen text.
// The skill `name` is keyed on the server's immutable id, never its display name: the name is
// user-controlled and can contain characters that are unsafe as a filesystem path or that collide
// with a bundled connector's skill name. The runtime routing key (`host.mcp("<name>", ...)`) still
// uses the display name, which is what McpClientManager registers the server under.
export function renderCustomSkillDoc(
  server: CustomSkillDocServer,
  tools: CustomSkillDocTool[]
): string {
  const useWhen =
    server.description ??
    `Use when you need tools from the ${server.name} MCP server — ${tools.map((t) => t.name).join(', ')}.`
  const header = `---\nname: mcp-${server.id}\ndescription: ${JSON.stringify(useWhen)}\nsource: connector\n---\n`
  const methods = tools
    .map(
      (t) =>
        `### ${t.name}\n\n${t.description ?? ''}\n\n\`\`\`json\n${JSON.stringify(t.inputSchema ?? {}, null, 2)}\n\`\`\`\n\n` +
        renderExample(server.name, t.name, t.inputSchema)
    )
    .join('\n')
  return (
    `${header}\n## When to Use\n\n${useWhen}\n\n` +
    `> This connector is rate-limited at the upstream API.\n\n${CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}
