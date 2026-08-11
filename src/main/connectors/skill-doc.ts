import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry'
import { customConnectorSlug } from '../../shared/custom-connector'

const CONVENTIONS = [
  'Reach this service ONLY from the REPL control-plane kernel: call it inside the `repl_execute` tool as `const result = await host.mcp(server, method, {...})`. host.mcp is async — always `await` it. The python and r DATA cells have NO connector access; do not call host.mcp (or urllib / requests / fetch) from them — it will fail.',
  "The result is a ready-to-use native JavaScript value — an object or array for most tools, sometimes a string or number. It is already parsed (not a JSON string). Each tool's **Returns** block gives its exact shape and field meanings; how you inspect or process it is up to you.",
  'The REPL is a persistent session: assign a result you will reuse to `globalThis` (e.g. `globalThis.hits = result`) so later `repl_execute` calls can see it, instead of running the call again. Each call hits the rate-limited upstream — never re-issue the same call to look at or reprocess a result you already have.',
  'Do NOT reimplement these calls with raw HTTP (urllib / requests / httpx / fetch) or hit the upstream endpoints directly — that bypasses the approval gate, per-tool policy, credentials, and rate limits, and can leak project data.',
  'Prefer bulk/list tools over per-item loops — the upstream API is rate-limited and shared across subagents.',
  'To use a result in a python or r cell, have the REPL write it under `process.env.OPEN_SCIENCE_HANDOFF_DIR`, then read the same `OPEN_SCIENCE_HANDOFF_DIR` path from the data cell — not through the model context or a cwd-relative handoff path.'
].join('\n')

// A Skill may be loaded outside the bundled-connector baseline (notably for custom MCP servers), so
// keep the minimum calling and reuse contract local without copying the full shared policy block.
const SKILL_CONVENTIONS =
  'Use from `repl_execute` as `const result = await host.mcp(server, method, {...})`. Results are native JavaScript in a persistent REPL; save reusable values on `globalThis` instead of running the call again, and never re-issue the same upstream call.'

const CUSTOM_SKILL_CONVENTIONS =
  `${SKILL_CONVENTIONS} Do not bypass \`host.mcp\` with raw HTTP or calls from Python/R: ` +
  'the host path enforces approval, tool policy, credentials, and rate limits.'

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

const inlineCode = (value: string): string => {
  const longestFence = Math.max(0, ...(value.match(/`+/g) ?? []).map((match) => match.length))
  const fence = '`'.repeat(longestFence + 1)
  return `${fence}${value}${fence}`
}

// Renders one tool's usage example as a copyable repl_execute (JS) cell. Prefers the descriptor's
// hand-authored `example` (a single `await host.mcp(...)` call with realistic args); otherwise builds a
// bare call from the schema. A tool with no concrete args renders as `await host.mcp(server, method)`
// (no third argument) — passing a literal `...` there would reach the bridge and raise, so it's omitted.
function renderExample(server: string, tool: string, schema: unknown, example?: string): string {
  if (example) return `**Example:** ${inlineCode(example)}\n`
  const args = exampleArgs(schema)
  const call = args
    ? `host.mcp("${server}", "${tool}", ${args})`
    : `host.mcp("${server}", "${tool}")`
  return `**Example:** ${inlineCode(`const result = await ${call}`)}\n`
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
        `### ${t.id}\n\n${t.description}\n\n**Input:** ${inlineCode(JSON.stringify(t.input))}\n\n` +
        (t.returns ? `**Returns:** ${t.returns}\n\n` : '') +
        renderExample(connectorId, t.id, t.input, t.example)
    )
    .join('\n')
  return (
    `${header}\n> This connector is rate-limited at the upstream API.\n\n` +
    `${SKILL_CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}

// Renders the small connector baseline shared by agents with on-demand skill loading. Detailed tool
// schemas and examples stay in the materialized `mcp-*` skills and enter context only when the agent
// loads the matching connector. Keeping this document to conventions prevents every enabled connector
// from consuming the initial context window while still steering calls through the approved host.mcp
// path instead of raw HTTP.
export function renderConnectorInstructions(skillNames: string[]): string {
  const enabledSkillNames = [...new Set(skillNames.filter((name) => /^mcp-[a-z0-9-]+$/.test(name)))]
  if (enabledSkillNames.length === 0) return ''
  const availableSkills = enabledSkillNames.map((name) => `\`${name}\``).join(', ')

  return (
    `# Open Science data connector conventions\n\n` +
    `Globally Enabled Connector Skills: ${availableSkills}.\n\n` +
    `A Specialist session may narrow this catalog. When an \`Allowed Specialist Skills for this session\` list is present, it is authoritative: do not load or call any \`mcp-*\` skill absent from that list.\n\n` +
    `Detailed instructions, exact server/method names, schemas, return shapes, and examples are available through the matching \`mcp-*\` skill. Load the matching \`mcp-*\` skill before the first \`host.mcp\` call. Never guess a connector server or method name; if the matching skill is not loaded, do not call the connector.\n\n` +
    CONVENTIONS
  )
}

export type CustomSkillDocServer = { name: string; slug?: string; description?: string }
export type CustomSkillDocTool = { name: string; description?: string; inputSchema?: unknown }

// Same shape as renderSkillDoc, but for a user-added custom MCP server: schema comes from
// McpClientManager.listTools() at runtime rather than a bundled descriptor table, and the
// trigger-style description falls back to a composed one when the server has no useWhen text.
// The skill name and host.mcp route both use the immutable safe slug. The display name remains free
// to contain spaces and punctuation and is used only in user-facing prose.
export function renderCustomSkillDoc(
  server: CustomSkillDocServer,
  tools: CustomSkillDocTool[]
): string {
  const slug = customConnectorSlug(server)
  const useWhen =
    server.description ??
    `Use when you need tools from the ${server.name} MCP server — ${tools.map((t) => t.name).join(', ')}.`
  const header = `---\nname: mcp-${slug}\ndescription: ${JSON.stringify(useWhen)}\nsource: connector\n---\n`
  const methods = tools
    .map(
      (t) =>
        `### ${t.name}\n\n${t.description ?? ''}\n\n**Input:** ${inlineCode(JSON.stringify(t.inputSchema ?? {}))}\n\n` +
        renderExample(slug, t.name, t.inputSchema)
    )
    .join('\n')
  return (
    `${header}\n> This connector is rate-limited at the upstream API.\n\n` +
    `${CUSTOM_SKILL_CONVENTIONS}\n\n## Tools\n\n${methods}`
  )
}
