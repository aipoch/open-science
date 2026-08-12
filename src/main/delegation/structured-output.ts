import { createHash } from 'node:crypto'

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

const DIALECT = '2020-12' as const
const DIALECT_URI = 'https://json-schema.org/draft/2020-12/schema'
const PROFILE = 'ajv-8-draft-2020-12-v1' as const

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
type JsonSchema = boolean | { [key: string]: JsonValue }

type StructuredOutputEvidence = Readonly<{
  attemptId: string
  dialect: typeof DIALECT
  profile: typeof PROFILE
  schemaDigest: string
  schema: JsonSchema
  accepted?: Readonly<{ value: JsonValue; acceptedAt: number }>
}>

type PreparedStructuredOutputSchema = Readonly<{
  dialect: typeof DIALECT
  profile: typeof PROFILE
  schemaDigest: string
  schema: JsonSchema
  validate: ValidateFunction
}>

type StructuredOutputEvidenceMessage = Readonly<{
  frameId: string
  role: 'user' | 'assistant'
  structuredOutputEvidence?: StructuredOutputEvidence
  structuredOutputEvidenceInvalid?: true
}>

class StructuredOutputEvidenceAssociationError extends Error {
  constructor() {
    super('Structured output evidence is malformed or cannot be associated.')
    this.name = 'StructuredOutputEvidenceAssociationError'
  }
}

const associateStructuredOutputEvidence = (
  messages: readonly StructuredOutputEvidenceMessage[],
  frameId: string,
  attemptId: string
): StructuredOutputEvidence | undefined => {
  const frameMessages = messages.filter((message) => message.frameId === frameId)
  if (frameMessages.some((message) => message.structuredOutputEvidenceInvalid)) {
    throw new StructuredOutputEvidenceAssociationError()
  }
  const initiatingMessage = frameMessages.find((message) => message.role === 'user')
  const matchingMessages = messages.filter(
    (message) => message.structuredOutputEvidence?.attemptId === attemptId
  )
  if (
    matchingMessages.length > 1 ||
    matchingMessages.some((message) => message !== initiatingMessage)
  ) {
    throw new StructuredOutputEvidenceAssociationError()
  }
  return initiatingMessage?.structuredOutputEvidence?.attemptId === attemptId
    ? initiatingMessage.structuredOutputEvidence
    : undefined
}

class StructuredOutputError extends Error {
  constructor(
    readonly code:
      | 'unsupported_schema'
      | 'structured_output_invalid_json'
      | 'structured_output_limit_exceeded'
      | 'structured_output_validation_failed',
    message: string,
    readonly keyword?: string,
    readonly instancePath?: string,
    readonly property?: string
  ) {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

const SCHEMA_LIMITS = { bytes: 64 * 1024, nodes: 1_000, depth: 32, properties: 128, items: 128 }
const VALUE_LIMITS = { bytes: 256 * 1024, nodes: 5_000, depth: 32, properties: 256, items: 1_000 }
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$ref',
  '$dynamicRef',
  '$defs',
  '$comment',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxContains',
  'minContains',
  'maxProperties',
  'minProperties',
  'required',
  'dependentRequired',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'items',
  'prefixItems',
  'contains',
  'properties',
  'additionalProperties',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'dependentSchemas',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'title',
  'description',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples'
])
const SAFE_ERROR_KEYWORDS = new Set([
  'type',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
  'contains',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'unevaluatedItems',
  'unevaluatedProperties'
])
const SCHEMA_MAP_KEYWORDS = new Set(['$defs', 'properties', 'dependentSchemas'])
const SCHEMA_VALUE_KEYWORDS = new Set([
  'additionalProperties',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'not',
  'if',
  'then',
  'else',
  'items',
  'contains',
  'contentSchema'
])
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const cloneJson = (value: unknown, limits: typeof SCHEMA_LIMITS): JsonValue => {
  let nodes = 0
  const walk = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1
    if (nodes > limits.nodes || depth > limits.depth) {
      throw new StructuredOutputError(
        'structured_output_limit_exceeded',
        'Structured output exceeds its complexity limit.'
      )
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new StructuredOutputError(
          'structured_output_invalid_json',
          'Structured output must contain only JSON values.'
        )
      }
      return candidate
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > limits.items || Object.keys(candidate).length !== candidate.length) {
        throw new StructuredOutputError(
          'structured_output_limit_exceeded',
          'Structured output array exceeds its limit or is sparse.'
        )
      }
      return candidate.map((item) => walk(item, depth + 1))
    }
    if (!isPlainObject(candidate)) {
      throw new StructuredOutputError(
        'structured_output_invalid_json',
        'Structured output must contain only JSON values.'
      )
    }
    const keys = Object.keys(candidate)
    if (keys.length > limits.properties || keys.some((key) => DANGEROUS_KEYS.has(key))) {
      throw new StructuredOutputError(
        'structured_output_limit_exceeded',
        'Structured output object exceeds its property limit or contains an unsafe key.'
      )
    }
    const result: { [key: string]: JsonValue } = Object.create(null)
    for (const key of keys) result[key] = walk(candidate[key], depth + 1)
    return result
  }
  const cloned = walk(value, 0)
  const serialized = JSON.stringify(cloned)
  if (Buffer.byteLength(serialized, 'utf8') > limits.bytes) {
    throw new StructuredOutputError(
      'structured_output_limit_exceeded',
      'Structured output exceeds its byte limit.'
    )
  }
  return cloned
}

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const inspectSchema = (schema: JsonValue): void => {
  if (Array.isArray(schema)) {
    for (const item of schema) inspectSchema(item)
    return
  }
  if (schema === null || typeof schema !== 'object') return
  for (const [keyword, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new StructuredOutputError('unsupported_schema', 'JSON Schema keyword is unsupported.')
    }
    if (keyword === '$schema' && value !== DIALECT_URI) {
      throw new StructuredOutputError('unsupported_schema', 'JSON Schema dialect is unsupported.')
    }
    if (
      (keyword === '$ref' || keyword === '$dynamicRef') &&
      (typeof value !== 'string' || !value.startsWith('#'))
    ) {
      throw new StructuredOutputError(
        'unsupported_schema',
        'Only document-local references are supported.'
      )
    }
    if (
      SCHEMA_MAP_KEYWORDS.has(keyword) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const nested of Object.values(value)) inspectSchema(nested)
    } else if (SCHEMA_VALUE_KEYWORDS.has(keyword)) {
      inspectSchema(value)
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(value)) {
      for (const nested of value) inspectSchema(nested)
    }
  }
}

const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  messages: false,
  verbose: false,
  addUsedSchema: false
})

const prepareStructuredOutputSchema = (input: unknown): PreparedStructuredOutputSchema => {
  let schemaValue: JsonValue
  try {
    schemaValue = cloneJson(input, SCHEMA_LIMITS)
    if (typeof schemaValue !== 'boolean' && (schemaValue === null || Array.isArray(schemaValue))) {
      throw new StructuredOutputError(
        'unsupported_schema',
        'JSON Schema must be an object or boolean.'
      )
    }
    const schema = schemaValue as JsonSchema
    inspectSchema(schema)
    const validate = ajv.compile(schema)
    return Object.freeze({
      dialect: DIALECT,
      profile: PROFILE,
      schemaDigest: createHash('sha256').update(canonicalJson(schema)).digest('hex'),
      schema: structuredClone(schema) as JsonSchema,
      validate
    })
  } catch (error) {
    if (error instanceof StructuredOutputError) throw error
    throw new StructuredOutputError('unsupported_schema', 'JSON Schema is invalid or unsupported.')
  }
}

const safeValidationError = (error: ErrorObject | undefined): StructuredOutputError => {
  const keyword = error && SAFE_ERROR_KEYWORDS.has(error.keyword) ? error.keyword : 'validation'
  const instancePath = (error?.instancePath ?? '').slice(0, 256)
  let property: string | undefined
  if (error && (error.keyword === 'required' || error.keyword === 'additionalProperties')) {
    const raw =
      error.keyword === 'required' ? error.params.missingProperty : error.params.additionalProperty
    if (typeof raw === 'string') property = raw.slice(0, 128)
  }
  return new StructuredOutputError(
    'structured_output_validation_failed',
    'Structured output does not match the admitted schema.',
    keyword,
    instancePath,
    property
  )
}

const validateStructuredOutputValue = (
  contract: Pick<PreparedStructuredOutputSchema, 'validate'>,
  input: unknown
): JsonValue => {
  const value = cloneJson(input, VALUE_LIMITS)
  if (!contract.validate(value)) throw safeValidationError(contract.validate.errors?.[0])
  return value
}

const canonicalStructuredOutputEqual = (left: JsonValue, right: JsonValue): boolean =>
  canonicalJson(left) === canonicalJson(right)

export {
  StructuredOutputError,
  StructuredOutputEvidenceAssociationError,
  associateStructuredOutputEvidence,
  canonicalStructuredOutputEqual,
  prepareStructuredOutputSchema,
  validateStructuredOutputValue
}
export type { JsonSchema, JsonValue, PreparedStructuredOutputSchema, StructuredOutputEvidence }
