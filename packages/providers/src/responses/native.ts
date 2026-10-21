import { resolveResponsesReasoningTransport } from '../protocols/reasoning'

type JsonObject = Record<string, unknown>
type NativeResponsesToolIdentity = Readonly<{ namespace: string; name: string }>
type NativeResponsesToolAliases = Map<string, NativeResponsesToolIdentity>
const isObject = (value: unknown): value is JsonObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
export class NativeResponsesRequestError extends Error {}
const namespaceAlias = (namespace: string, name: string): string => `${namespace}__${name}`

const combinedDescription = (namespaceDescription: unknown, toolDescription: unknown): string =>
  [namespaceDescription, toolDescription]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('\n\n')

const flattenHistoryItem = (item: unknown): unknown => {
  if (!isObject(item)) return item
  if (
    (item.type !== 'function_call' && item.type !== 'custom_tool_call') ||
    typeof item.namespace !== 'string' ||
    typeof item.name !== 'string'
  ) {
    return item
  }

  const { namespace, ...withoutNamespace } = item
  return { ...withoutNamespace, name: namespaceAlias(namespace, item.name) }
}

const flattenToolChoice = (toolChoice: unknown): unknown => {
  if (
    !isObject(toolChoice) ||
    typeof toolChoice.namespace !== 'string' ||
    typeof toolChoice.name !== 'string'
  ) {
    return toolChoice
  }

  const { namespace, ...withoutNamespace } = toolChoice
  return { ...withoutNamespace, name: namespaceAlias(namespace, toolChoice.name) }
}

const flattenNativeResponsesRequest = (
  body: JsonObject
): { request: JsonObject; aliases: NativeResponsesToolAliases } => {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new NativeResponsesRequestError('native Responses tools must be an array')
  }

  const tools = (body.tools ?? []) as unknown[]
  const aliases: NativeResponsesToolAliases = new Map()
  const occupiedNames = new Set(
    tools.flatMap((tool) =>
      isObject(tool) && tool.type !== 'namespace' && typeof tool.name === 'string'
        ? [tool.name]
        : []
    )
  )
  const flattenedTools = tools.flatMap((tool) => {
    if (!isObject(tool) || tool.type !== 'namespace') return [tool]
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) {
      throw new NativeResponsesRequestError(
        'native Responses namespace tools require a name and child tools'
      )
    }

    const namespace = tool.name
    return tool.tools.map((child) => {
      if (!isObject(child) || child.type !== 'function' || typeof child.name !== 'string') {
        throw new NativeResponsesRequestError(
          'native Responses namespace children must be function tools'
        )
      }
      const alias = namespaceAlias(namespace, child.name)
      if (occupiedNames.has(alias) || aliases.has(alias)) {
        throw new NativeResponsesRequestError(`duplicate native Responses tool alias: ${alias}`)
      }
      occupiedNames.add(alias)
      aliases.set(alias, { namespace, name: child.name })
      const description = combinedDescription(tool.description, child.description)
      return {
        ...child,
        name: alias,
        ...(description ? { description } : {})
      }
    })
  })

  return {
    request: {
      ...body,
      ...(body.tools === undefined ? {} : { tools: flattenedTools }),
      ...(body.tool_choice === undefined
        ? {}
        : { tool_choice: flattenToolChoice(body.tool_choice) }),
      ...(Array.isArray(body.input) ? { input: body.input.map(flattenHistoryItem) } : {})
    },
    aliases
  }
}

const restoreNativeResponsesPayload = (
  value: unknown,
  aliases: NativeResponsesToolAliases
): unknown => {
  if (Array.isArray(value)) return value.map((item) => restoreNativeResponsesPayload(item, aliases))
  if (!isObject(value)) return value

  const restored = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      restoreNativeResponsesPayload(child, aliases)
    ])
  ) as JsonObject
  if (
    (restored.type === 'function_call' || restored.type === 'custom_tool_call') &&
    restored.namespace === undefined &&
    typeof restored.name === 'string'
  ) {
    const identity = aliases.get(restored.name)
    if (identity) {
      restored.name = identity.name
      restored.namespace = identity.namespace
    }
  }
  return restored
}

export type NativeResponsesProjection = Readonly<{
  request: JsonObject
  toolCount: number
  resolveTool(name: string): NativeResponsesToolIdentity | undefined
  restore(value: unknown): unknown
}>
/** Binds the response decoder to the namespace declarations of one request. */
export const prepareNativeResponsesRequest = (
  body: JsonObject,
  vendorId?: string
): NativeResponsesProjection => {
  const { request, aliases } = flattenNativeResponsesRequest(body)
  // Codex can send `none` even for an always-thinking model. Apply the same provider policy
  // as direct Responses calls, preserving unrelated reasoning fields and the caller's payload.
  if (isObject(request.reasoning) && request.reasoning.effort === 'none') {
    request.reasoning = {
      ...request.reasoning,
      ...resolveResponsesReasoningTransport(
        vendorId,
        typeof request.model === 'string' ? request.model : undefined,
        'none'
      ).reasoning
    }
  }
  return Object.freeze({
    request,
    toolCount: aliases.size,
    resolveTool: (name: string) => {
      const identity = aliases.get(name)
      return identity ? { ...identity } : undefined
    },
    restore: (value: unknown) => restoreNativeResponsesPayload(value, aliases)
  })
}
