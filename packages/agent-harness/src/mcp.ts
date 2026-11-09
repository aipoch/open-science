import { createHash } from 'node:crypto'
import { frozen, json } from './session-state'
import type { AgentTool, ContentBlock, Json, ToolContext, ToolResult } from './session-types'

export type McpToolDefinition = {
  name: string
  description?: string
  inputSchema: Json
  outputSchema?: Json
}

/** The host owns the SDK client, connection, credentials, cancellation and remote drain. */
export type McpToolClient = {
  listTools(cursor: string | undefined, signal: AbortSignal): Promise<unknown>
  callTool(name: string, args: Record<string, Json>, context: ToolContext): Promise<unknown>
}
export type McpToolBinding = Pick<AgentTool, 'validate' | 'authorize'> & {
  /** Explicit host projection, e.g. removing unavailable background capabilities. */
  parameters?: Json
  description?: string
  scheduling?: AgentTool['scheduling']
  /** Required when a server declares an output schema; use the host's JSON Schema validator. */
  validateOutput?: (value: Json) => void
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Invalid MCP object')
  return value as Record<string, unknown>
}

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  return value
}

/** Preserve references as data. Never resolve resource URLs or silently discard unknown content. */
export function mcpToolResult(value: unknown): ToolResult {
  json(value)
  if (!value || Array.isArray(value) || typeof value !== 'object' || !Array.isArray(value.content))
    throw new Error('Invalid MCP tool result')
  if (value.isError !== undefined && typeof value.isError !== 'boolean')
    throw new Error('Invalid MCP tool error flag')
  const content: ContentBlock[] = value.content.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block))
      throw new Error('Invalid MCP content block')
    if (typeof block.type !== 'string') throw new Error('Invalid MCP content type')
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('Invalid MCP text')
      return { type: 'text', text: block.text }
    }
    if (block.type === 'image' || block.type === 'audio') {
      if (
        typeof block.data !== 'string' ||
        typeof block.mimeType !== 'string' ||
        !new RegExp(`^${block.type}/[a-zA-Z0-9.+-]+$`).test(block.mimeType)
      )
        throw new Error(`Invalid MCP ${block.type}`)
      return {
        type: block.type,
        mimeType: block.mimeType,
        source: `data:${block.mimeType};base64,${block.data}`
      }
    }
    if (
      block.type === 'resource' &&
      block.resource &&
      typeof block.resource === 'object' &&
      !Array.isArray(block.resource) &&
      'blob' in block.resource &&
      block.resource.mimeType !== undefined
    ) {
      const resource = block.resource
      if (
        typeof resource.blob !== 'string' ||
        typeof resource.mimeType !== 'string' ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(resource.mimeType)
      )
        throw new Error('Invalid MCP media resource')
      const type = resource.mimeType.startsWith('audio/')
        ? 'audio'
        : resource.mimeType.startsWith('video/')
          ? 'video'
          : resource.mimeType.startsWith('image/')
            ? 'image'
            : 'file'
      return {
        type,
        mimeType: resource.mimeType,
        source: `data:${resource.mimeType};base64,${resource.blob}`
      }
    }
    // Unresolved references and extension blocks remain evidence, never fetched automatically.
    return { type: 'text', text: JSON.stringify(block) }
  })
  if (value.structuredContent !== undefined) {
    if (
      !value.structuredContent ||
      typeof value.structuredContent !== 'object' ||
      Array.isArray(value.structuredContent)
    )
      throw new Error('Invalid MCP structured content')
    const serialized = JSON.stringify(value.structuredContent)
    const duplicate = content.some((block) => {
      if (block.type !== 'text') return false
      try {
        return (
          JSON.stringify(canonical(JSON.parse(block.text))) ===
          JSON.stringify(canonical(value.structuredContent!))
        )
      } catch {
        return false
      }
    })
    if (!duplicate) content.push({ type: 'text', text: serialized })
  }
  return { content, ...(value.isError !== undefined ? { isError: value.isError } : {}) }
}

/** One immutable discovery snapshot. Refresh explicitly between turns via session.configure/scope. */
export async function loadMcpTools(options: {
  client: McpToolClient
  signal: AbortSignal
  /** Returning undefined excludes a capability. Server annotations never grant authorization. */
  bind(definition: Readonly<McpToolDefinition>): McpToolBinding | undefined
}): Promise<readonly AgentTool[]> {
  const tools: AgentTool[] = [],
    names = new Set<string>(),
    cursors = new Set<string>()
  let cursor: string | undefined
  do {
    options.signal.throwIfAborted()
    const page = record(await options.client.listTools(cursor, options.signal))
    options.signal.throwIfAborted()
    if (
      !page ||
      typeof page !== 'object' ||
      Array.isArray(page) ||
      !Array.isArray(page.tools) ||
      (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
    )
      throw new Error('Invalid MCP tool list')
    for (const entry of page.tools) {
      const source = record(entry)
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        typeof source.name !== 'string' ||
        (source.description !== undefined && typeof source.description !== 'string') ||
        !source.inputSchema ||
        typeof source.inputSchema !== 'object' ||
        Array.isArray(source.inputSchema)
      )
        throw new Error('Invalid MCP tool definition')
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source.name) || names.has(source.name))
        throw new Error('Invalid or duplicate MCP tool name')
      names.add(source.name)
      json(source.inputSchema)
      if (source.outputSchema !== undefined) json(source.outputSchema)
      const descriptor: Readonly<McpToolDefinition> = frozen({
        name: source.name,
        inputSchema: source.inputSchema,
        ...(source.description !== undefined ? { description: source.description } : {}),
        ...(source.outputSchema !== undefined ? { outputSchema: source.outputSchema } : {})
      })
      const binding = options.bind(descriptor)
      if (!binding) continue
      if (descriptor.outputSchema !== undefined && !binding.validateOutput)
        throw new Error('MCP output schema requires a validator')
      const parameters = canonical(binding.parameters ?? descriptor.inputSchema)
      json(parameters)
      const description = binding.description ?? descriptor.description ?? ''
      const version = createHash('sha256')
        .update(
          JSON.stringify([
            description,
            parameters,
            descriptor.outputSchema === undefined ? null : canonical(descriptor.outputSchema)
          ])
        )
        .digest('hex')
      const { validate, authorize, validateOutput } = binding
      tools.push(
        Object.freeze({
          name: descriptor.name,
          version,
          description,
          parameters: frozen(parameters),
          scheduling: binding.scheduling ?? 'exclusive',
          validate,
          authorize,
          async execute(args: Json, context: ToolContext) {
            context.signal.throwIfAborted()
            if (!args || Array.isArray(args) || typeof args !== 'object')
              throw new Error('MCP arguments must be an object')
            // No catch/retry: a transport rejection or invalid reply leaves effects unknown in the core.
            const raw = await options.client.callTool(descriptor.name, args, context)
            const result = mcpToolResult(raw)
            if (validateOutput && !result.isError) {
              const structured = (raw as { structuredContent?: Json }).structuredContent
              if (structured === undefined) throw new Error('Missing MCP structured output')
              validateOutput(structured)
            }
            return result
          }
        })
      )
    }
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor) || cursors.size >= 100)
        throw new Error('Invalid MCP pagination')
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  return Object.freeze(tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
}
