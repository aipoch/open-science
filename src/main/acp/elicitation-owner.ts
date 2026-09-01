import { randomUUID } from 'node:crypto'

import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'

import {
  MAX_ELICITATION_ANSWERS,
  MAX_ELICITATION_LABEL_CHARS,
  MAX_ELICITATION_MESSAGE_CHARS,
  MAX_ELICITATION_MULTI_SELECT_VALUES,
  isValidElicitationValue,
  resolveAgentUserChoiceQuestions,
  sanitizeElicitationField,
  sanitizeElicitationProjection,
  sanitizePendingElicitationRequest,
  type ElicitationAnswer,
  type ElicitationField,
  type ElicitationProjection,
  type ElicitationResponse,
  type AgentTurnProvenanceContext,
  type PendingElicitationRequest
} from '../../shared/elicitation'
import { isRecord } from '../value-guards'

type ElicitationRoute = {
  sessionId: string
}

type PendingElicitation = {
  request: PendingElicitationRequest
  projection: ElicitationProjection
  resolve?: (response: CreateElicitationResponse) => void
}

export type ResolvedElicitation = {
  request: PendingElicitationRequest
  response: CreateElicitationResponse
  detached: boolean
}

type AcpElicitationOwnerOptions = {
  createRequestId?: () => string
  now?: () => number
  onProjection: (request: PendingElicitationRequest, projection: ElicitationProjection) => void
}

type DurableChoiceContext = {
  promptMessageId?: string
  provenanceContext?: AgentTurnProvenanceContext
}

const KNOWN_FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array'])
const KNOWN_STRING_FORMATS = new Set(['email', 'uri', 'date', 'date-time'])

const readString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

const readBoundedDataString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= MAX_ELICITATION_LABEL_CHARS
    ? value
    : undefined

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const readNonNegativeInteger = (value: unknown): number | undefined => {
  const number = readNumber(value)
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined
}

const normalizeOptions = (value: unknown): ElicitationField['options'] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined

  const options = value.flatMap((candidate) => {
    if (typeof candidate === 'string') return [{ value: candidate, label: candidate }]
    if (!isRecord(candidate)) return []
    const optionValue = readBoundedDataString(candidate.const)
    const label = readString(candidate.title)
    if (!optionValue || !label) return []
    const description = readString(candidate.description)
    return [{ value: optionValue, label, ...(description ? { description } : {}) }]
  })

  return options.length === value.length &&
    new Set(options.map((option) => option.value)).size === options.length
    ? options
    : undefined
}

const withValidDefault = (
  field: ElicitationField,
  defaultValue: unknown
): ElicitationField | undefined => sanitizeElicitationField({ ...field, defaultValue })

const normalizeField = (
  id: string,
  schema: unknown,
  required: ReadonlySet<string>
): ElicitationField | undefined => {
  if (!isRecord(schema)) return undefined
  const type = readString(schema.type)
  const label = readString(schema.title) ?? id
  const description = readString(schema.description)
  const common = {
    id,
    label,
    ...(description ? { description } : {}),
    ...(required.has(id) ? { required: true } : {})
  }

  if (type === 'string') {
    if ('pattern' in schema && schema.pattern != null) return undefined
    const rawOptions = Array.isArray(schema.oneOf) ? schema.oneOf : schema.enum
    const options = normalizeOptions(rawOptions)
    if (rawOptions !== undefined && !options) return undefined
    const format =
      schema.format === 'email' ||
      schema.format === 'uri' ||
      schema.format === 'date' ||
      schema.format === 'date-time'
        ? schema.format
        : undefined
    const defaultValue = typeof schema.default === 'string' ? schema.default : undefined
    const minLength = readNonNegativeInteger(schema.minLength)
    const maxLength = readNonNegativeInteger(schema.maxLength)
    if (
      (minLength !== undefined && minLength > MAX_ELICITATION_MESSAGE_CHARS) ||
      (minLength !== undefined && maxLength !== undefined && minLength > maxLength) ||
      (required.has(id) && maxLength === 0)
    ) {
      return undefined
    }
    const field: ElicitationField = {
      ...common,
      kind: options ? 'single-select' : 'text',
      ...(options ? { options } : {}),
      ...(format ? { format } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {})
    }
    return withValidDefault(field, defaultValue)
  }

  if (type === 'number' || type === 'integer') {
    const defaultValue = readNumber(schema.default)
    const minimum = readNumber(schema.minimum)
    const maximum = readNumber(schema.maximum)
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) return undefined
    const field: ElicitationField = {
      ...common,
      kind: type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {})
    }
    return withValidDefault(field, defaultValue)
  }

  if (type === 'boolean') {
    const field: ElicitationField = {
      ...common,
      kind: 'boolean'
    }
    return withValidDefault(field, schema.default)
  }

  if (type === 'array' && isRecord(schema.items)) {
    const rawOptions = Array.isArray(schema.items.anyOf)
      ? schema.items.anyOf
      : schema.items.type === 'string'
        ? schema.items.enum
        : undefined
    const options = normalizeOptions(rawOptions)
    if (!options) return undefined
    const defaultValue =
      Array.isArray(schema.default) && schema.default.every((item) => typeof item === 'string')
        ? schema.default
        : undefined
    const minItems = readNonNegativeInteger(schema.minItems)
    const maxItems = readNonNegativeInteger(schema.maxItems)
    if (
      (minItems !== undefined && minItems > MAX_ELICITATION_MULTI_SELECT_VALUES) ||
      (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
      (minItems !== undefined && minItems > options.length) ||
      (required.has(id) && maxItems === 0)
    ) {
      return undefined
    }
    const field: ElicitationField = {
      ...common,
      kind: 'multi-select',
      options,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {})
    }
    return withValidDefault(field, defaultValue)
  }

  return undefined
}

const normalizeFormRequest = (
  params: CreateElicitationRequest,
  requestId: string,
  route: ElicitationRoute
): PendingElicitationRequest | undefined => {
  if (params.mode !== 'form' || !('requestedSchema' in params)) return undefined
  const schema = params.requestedSchema
  if (!isRecord(schema)) return undefined
  const properties = schema.properties
  if (!isRecord(properties) || Object.keys(properties).length === 0) return undefined

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : []
  )
  if (Array.from(required).some((id) => !(id in properties))) return undefined
  const fields = Object.entries(properties).map(([id, field]) =>
    normalizeField(id, field, required)
  )
  if (fields.some((field) => !field)) return undefined

  const message = readString(params.message)
  if (!message) return undefined
  const toolCallId = 'toolCallId' in params ? readBoundedDataString(params.toolCallId) : undefined
  if (!toolCallId) return undefined

  return {
    requestId,
    sessionId: route.sessionId,
    toolCallId,
    message,
    fields: fields as ElicitationField[]
  }
}

const containsUnknownFieldSchema = (params: CreateElicitationRequest): boolean => {
  if (params.mode !== 'form' || !('requestedSchema' in params)) return false
  const requestedSchema = params.requestedSchema
  if (!isRecord(requestedSchema)) return false
  const properties = requestedSchema.properties
  if (!isRecord(properties)) return false

  return Object.values(properties).some((schema) => {
    if (!isRecord(schema) || !('type' in schema)) return false
    if (typeof schema.type !== 'string') return true
    if (!KNOWN_FIELD_TYPES.has(schema.type)) return true
    if (schema.type === 'string' && 'format' in schema && schema.format != null) {
      return typeof schema.format !== 'string' || !KNOWN_STRING_FORMATS.has(schema.format)
    }
    if (schema.type !== 'array' || !isRecord(schema.items)) return false
    if (!('type' in schema.items)) return false
    return typeof schema.items.type !== 'string' || schema.items.type !== 'string'
  })
}

export const validateElicitationAnswers = (
  request: PendingElicitationRequest,
  answers: ElicitationAnswer[] | undefined
): ElicitationAnswer[] => {
  const candidates = answers ?? []
  if (candidates.length > MAX_ELICITATION_ANSWERS) {
    throw new Error('Invalid structured input response')
  }
  const fields = new Map(request.fields.map((field) => [field.id, field]))
  const seen = new Set<string>()

  for (const answer of candidates) {
    const field = fields.get(answer.fieldId)
    if (!field || seen.has(answer.fieldId) || !isValidElicitationValue(field, answer.value)) {
      throw new Error('Invalid structured input response')
    }
    seen.add(answer.fieldId)
  }
  if (request.fields.some((field) => field.required && !seen.has(field.id))) {
    throw new Error('Required structured input is missing')
  }
  return candidates
}

const isLosslessFieldProjection = (
  sourceFields: ElicitationField[],
  projectedFields: ElicitationField[]
): boolean =>
  projectedFields.length === sourceFields.length &&
  projectedFields.every((field, index) => {
    const source = sourceFields[index]
    if (field.id !== source.id) return false
    const options = field.options ?? []
    const sourceOptions = source.options ?? []
    return (
      options.length === sourceOptions.length &&
      options.every((option, optionIndex) => option.value === sourceOptions[optionIndex].value)
    )
  })

export class AcpElicitationOwner {
  private readonly pending = new Map<string, PendingElicitation>()
  private readonly createRequestId: () => string
  private readonly now: () => number

  constructor(private readonly options: AcpElicitationOwnerOptions) {
    this.createRequestId = options.createRequestId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  private tryPublishProjection(
    request: PendingElicitationRequest,
    projection: ElicitationProjection
  ): boolean {
    try {
      this.options.onProjection(request, projection)
      return true
    } catch {
      return false
    }
  }

  private prepare(
    params: CreateElicitationRequest,
    route: ElicitationRoute,
    durable?: NonNullable<ElicitationProjection['durable']>,
    durableChoiceContext?: DurableChoiceContext
  ): { request: PendingElicitationRequest; projection: ElicitationProjection } | undefined {
    if (containsUnknownFieldSchema(params)) return undefined
    const requestId = durable?.requestId ?? this.createRequestId()
    const request = normalizeFormRequest(params, requestId, route)
    if (!request || this.pending.has(requestId)) return undefined
    const resolvedDurable =
      durable ??
      (durableChoiceContext && resolveAgentUserChoiceQuestions(request.fields)
        ? {
            kind: 'agent-user-choice' as const,
            requestId,
            ...(durableChoiceContext.promptMessageId
              ? { promptMessageId: durableChoiceContext.promptMessageId }
              : {}),
            ...(durableChoiceContext.provenanceContext
              ? { provenanceContext: durableChoiceContext.provenanceContext }
              : {})
          }
        : undefined)

    const projection = sanitizeElicitationProjection({
      message: request.message,
      fields: request.fields,
      state: 'pending',
      ...(resolvedDurable ? { durable: resolvedDurable } : {})
    })
    if (!projection) return undefined
    if (!isLosslessFieldProjection(request.fields, projection.fields)) return undefined

    return {
      request: {
        ...request,
        message: projection.message,
        fields: projection.fields,
        ...(projection.durable ? { durable: projection.durable } : {})
      },
      projection
    }
  }

  request(
    params: CreateElicitationRequest,
    route: ElicitationRoute,
    durableChoiceContext?: DurableChoiceContext
  ): Promise<CreateElicitationResponse> {
    if (containsUnknownFieldSchema(params)) return Promise.resolve({ action: 'cancel' })
    const prepared = this.prepare(params, route, undefined, durableChoiceContext)
    if (!prepared) return Promise.resolve({ action: 'decline' })
    const { request, projection } = prepared

    return new Promise((resolve) => {
      this.pending.set(request.requestId, { request, projection, resolve })
      if (!this.tryPublishProjection(request, projection)) {
        this.pending.delete(request.requestId)
        resolve({ action: 'cancel' })
      }
    })
  }

  requestDetached(
    params: CreateElicitationRequest,
    route: ElicitationRoute,
    durable: NonNullable<ElicitationProjection['durable']>
  ): PendingElicitationRequest | undefined {
    const prepared = this.prepare(params, route, durable)
    if (!prepared) return undefined
    const { request, projection } = prepared
    this.pending.set(request.requestId, { request, projection })
    if (this.tryPublishProjection(request, projection)) return structuredClone(request)
    this.pending.delete(request.requestId)
    return undefined
  }

  appendDetached(
    requestId: string,
    fields: ElicitationField[]
  ): PendingElicitationRequest | undefined {
    const pending = this.pending.get(requestId)
    if (!pending || pending.resolve || !pending.request.durable || fields.length === 0) {
      return undefined
    }

    const fieldIds = new Set(pending.request.fields.map((field) => field.id))
    for (const field of fields) {
      if (fieldIds.has(field.id)) return undefined
      fieldIds.add(field.id)
    }
    const mergedFields = [...pending.request.fields, ...fields]
    const projection = sanitizeElicitationProjection({
      ...pending.projection,
      fields: mergedFields,
      state: 'pending'
    })
    if (!projection || !isLosslessFieldProjection(mergedFields, projection.fields)) {
      return undefined
    }

    const request = { ...pending.request, fields: projection.fields }
    this.pending.set(requestId, { ...pending, request, projection })
    if (this.tryPublishProjection(request, projection)) return structuredClone(request)
    this.pending.set(requestId, pending)
    return undefined
  }

  restoreDetached(value: unknown): PendingElicitationRequest | undefined {
    const request = sanitizePendingElicitationRequest(value)
    if (!request?.durable || this.pending.has(request.requestId)) return undefined
    const projection = sanitizeElicitationProjection({
      message: request.message,
      fields: request.fields,
      state: 'pending',
      durable: request.durable
    })
    if (!projection) return undefined
    this.pending.set(request.requestId, { request, projection })
    return structuredClone(request)
  }

  respond(response: ElicitationResponse): ResolvedElicitation {
    const pending = this.pending.get(response.requestId)
    if (!pending) throw new Error('Unknown structured input request')

    let protocolResponse: CreateElicitationResponse
    let answers: ElicitationAnswer[] | undefined
    let state: ElicitationProjection['state']

    if (response.action === 'accept') {
      answers = validateElicitationAnswers(pending.request, response.answers)
      protocolResponse = {
        action: 'accept',
        content: Object.fromEntries(answers.map((answer) => [answer.fieldId, answer.value]))
      }
      state = 'answered'
    } else {
      protocolResponse = { action: response.action }
      state = response.action === 'decline' ? 'declined' : 'cancelled'
    }

    this.pending.delete(response.requestId)
    const projection: ElicitationProjection = {
      ...pending.projection,
      state,
      ...(answers && answers.length > 0 ? { answers } : {}),
      respondedAt: this.now()
    }
    this.tryPublishProjection(pending.request, projection)
    pending.resolve?.(protocolResponse)
    return {
      request: structuredClone(pending.request),
      response: protocolResponse,
      detached: pending.resolve === undefined
    }
  }

  getPendingRequests(): PendingElicitationRequest[] {
    return Array.from(this.pending.values(), ({ request }) => structuredClone(request))
  }

  cancelForSession(sessionId: string): void {
    for (const pending of Array.from(this.pending.values())) {
      if (pending.request.sessionId === sessionId) {
        this.respond({ requestId: pending.request.requestId, action: 'cancel' })
      }
    }
  }

  dispose(): void {
    for (const pending of Array.from(this.pending.values())) {
      if (pending.resolve && !pending.request.durable) {
        this.respond({ requestId: pending.request.requestId, action: 'cancel' })
      } else {
        this.pending.delete(pending.request.requestId)
      }
    }
  }
}
