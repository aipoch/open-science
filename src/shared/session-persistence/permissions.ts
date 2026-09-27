import {
  PERMISSION_CAPABILITY_KINDS,
  type PermissionCapability,
  EXACT_PERMISSION_QUALIFIER_PATTERN
} from '../permission-grants'
import { asString, isRecord, asNumber } from './primitives'
import { sanitizeRawToolPayload, sanitizeToolDetailText } from '../tool-detail-sanitizer'
import type { AcpPermissionRequest } from '../acp'
import type { SessionPermissionRuntimeContext } from '../session-runtime-context'

const PERMISSION_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

const PERMISSION_SCOPES = new Set(['once', 'session', 'project', 'global'])

const PERMISSION_OPTION_KINDS = new Set([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always'
])

const PERMISSION_CAPABILITY_KIND_SET = new Set<string>(PERMISSION_CAPABILITY_KINDS)

const MAX_PERMISSION_CONTEXT_STRING_CHARS = 16_000

const MAX_PERMISSION_CONTEXT_RAW_CHARS = 8_000

const boundedPermissionString = (value: unknown): string | undefined => {
  const text = asString(value)
  return text && text.length <= MAX_PERMISSION_CONTEXT_STRING_CHARS ? text : undefined
}

const sanitizePermissionRawInput = (value: unknown): unknown | undefined => {
  if (value === null) return null
  return sanitizeRawToolPayload(value, MAX_PERMISSION_CONTEXT_RAW_CHARS)
}

const sanitizePermissionCapability = (value: unknown): PermissionCapability | undefined => {
  if (!isRecord(value)) return undefined
  const kind = asString(value.kind)
  const key = boundedPermissionString(value.key)?.trim()
  if (!kind || !PERMISSION_CAPABILITY_KIND_SET.has(kind) || !key) return undefined

  if (value.qualifier === undefined) {
    return { kind: kind as PermissionCapability['kind'], key }
  }
  if (!isRecord(value.qualifier)) return undefined
  const mode = asString(value.qualifier.mode)
  if (mode === 'any') {
    return { kind: kind as PermissionCapability['kind'], key, qualifier: { mode } }
  }
  const qualifierValue = boundedPermissionString(value.qualifier.value)?.trim()
  if (
    (mode !== 'category' && mode !== 'exact') ||
    !qualifierValue ||
    (mode === 'exact' && !EXACT_PERMISSION_QUALIFIER_PATTERN.test(qualifierValue))
  ) {
    return undefined
  }
  return {
    kind: kind as PermissionCapability['kind'],
    key,
    qualifier: { mode, value: qualifierValue }
  }
}

const sanitizePermissionRequest = (value: unknown): AcpPermissionRequest | undefined => {
  if (!isRecord(value)) return undefined
  const requestId = boundedPermissionString(value.requestId)
  const sessionId = boundedPermissionString(value.sessionId)
  const toolCallId = boundedPermissionString(value.toolCallId)
  const rawTitle = asString(value.title)
  const title = rawTitle ? sanitizeToolDetailText(rawTitle) : undefined
  if (!requestId || !sessionId || !toolCallId || !title || !Array.isArray(value.options)) {
    return undefined
  }

  const optionIds = new Set<string>()
  const options = value.options.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const optionId = boundedPermissionString(candidate.optionId)
    const name = boundedPermissionString(candidate.name)
    const kind = boundedPermissionString(candidate.kind)
    const scope = asString(candidate.scope)
    const normalizedKind = kind?.toLowerCase()
    if (
      !optionId ||
      !name ||
      !kind ||
      !normalizedKind ||
      !PERMISSION_OPTION_KINDS.has(normalizedKind) ||
      optionIds.has(optionId) ||
      (scope !== undefined && !PERMISSION_SCOPES.has(scope)) ||
      (scope === 'once' && normalizedKind !== 'allow_once') ||
      ((scope === 'session' || scope === 'project' || scope === 'global') &&
        normalizedKind !== 'allow_always')
    ) {
      return []
    }
    optionIds.add(optionId)
    return [
      {
        optionId,
        name,
        kind,
        ...(scope
          ? { scope: scope as NonNullable<AcpPermissionRequest['options'][number]['scope']> }
          : {})
      }
    ]
  })
  if (options.length === 0 || options.length !== value.options.length || options.length > 32) {
    return undefined
  }

  const request: AcpPermissionRequest = { requestId, sessionId, toolCallId, title, options }
  const status = boundedPermissionString(value.status)
  const providerToolName = boundedPermissionString(value.providerToolName)
  const mcpIdentity = boundedPermissionString(value.mcpIdentity)
  const toolKind = boundedPermissionString(value.toolKind)
  const commandPrefix = Array.isArray(value.commandPrefix)
    ? value.commandPrefix.map(boundedPermissionString).filter((item): item is string => !!item)
    : undefined
  const toolLocations = Array.isArray(value.toolLocations)
    ? value.toolLocations.flatMap((candidate) => {
        if (!isRecord(candidate)) return []
        const path = boundedPermissionString(candidate.path)
        const line = asNumber(candidate.line)
        if (!path || (line !== undefined && (!Number.isSafeInteger(line) || line < 0))) return []
        return [{ path, ...(line === undefined ? {} : { line }) }]
      })
    : undefined
  // rawInput is an optional UI preview. The full request fingerprint remains the replay boundary,
  // so an oversized preview must not discard the permission wait itself.
  const rawInput = sanitizePermissionRawInput(value.rawInput)
  if (
    value.toolLocations !== undefined &&
    (!Array.isArray(value.toolLocations) ||
      toolLocations?.length !== value.toolLocations.length ||
      toolLocations.length > 100)
  ) {
    return undefined
  }
  if (
    value.commandPrefix !== undefined &&
    (!Array.isArray(value.commandPrefix) ||
      commandPrefix?.length !== value.commandPrefix.length ||
      commandPrefix.length > 32)
  ) {
    return undefined
  }

  if (status) request.status = status
  if (providerToolName) request.providerToolName = providerToolName
  if (typeof value.isMcp === 'boolean') request.isMcp = value.isMcp
  if (mcpIdentity) request.mcpIdentity = mcpIdentity
  if (toolKind) request.toolKind = toolKind as AcpPermissionRequest['toolKind']
  if (toolLocations) {
    request.toolLocations = toolLocations as AcpPermissionRequest['toolLocations']
  }
  if (commandPrefix) request.commandPrefix = commandPrefix
  if (rawInput !== undefined) request.rawInput = rawInput
  return request
}

export const sanitizeSessionPermissionRuntimeContext = (
  value: unknown
): SessionPermissionRuntimeContext | undefined => {
  if (!isRecord(value)) return undefined
  if (
    Object.keys(value).some(
      (field) =>
        ![
          'request',
          'state',
          'originatingPromptMessageId',
          'fingerprint',
          'categoryKey',
          'capability',
          'createdAt'
        ].includes(field)
    )
  ) {
    return undefined
  }
  const request = sanitizePermissionRequest(value.request)
  const state = value.state === undefined ? 'pending' : asString(value.state)
  const originatingPromptMessageId = boundedPermissionString(value.originatingPromptMessageId)
  const fingerprint = asString(value.fingerprint)
  const categoryKey = boundedPermissionString(value.categoryKey)
  const capability = sanitizePermissionCapability(value.capability)
  const createdAt = asNumber(value.createdAt)
  if (
    !request ||
    (state !== 'pending' && state !== 'continuing') ||
    !originatingPromptMessageId ||
    !fingerprint ||
    !PERMISSION_FINGERPRINT_PATTERN.test(fingerprint) ||
    createdAt === undefined ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    (value.capability !== undefined && !capability)
  ) {
    return undefined
  }
  return {
    state,
    request,
    originatingPromptMessageId,
    fingerprint,
    ...(categoryKey ? { categoryKey } : {}),
    ...(capability ? { capability } : {}),
    createdAt
  }
}
