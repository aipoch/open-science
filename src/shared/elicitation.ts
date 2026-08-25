export type ElicitationValue = string | number | boolean | string[]

export type ElicitationOption = {
  value: string
  label: string
  description?: string
}

export type ElicitationField = {
  id: string
  label: string
  description?: string
  kind: 'text' | 'single-select' | 'multi-select' | 'number' | 'integer' | 'boolean'
  required?: boolean
  options?: ElicitationOption[]
  format?: 'email' | 'uri' | 'date' | 'date-time'
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  defaultValue?: ElicitationValue
}

export type AgentUserChoiceQuestion = {
  choiceField: ElicitationField
  customField: ElicitationField
}

export type ElicitationAnswer = {
  fieldId: string
  value: ElicitationValue
}

export type AgentTurnProvenanceContext = {
  promptMessageId: string
  // A suppressed application continuation may use a synthetic prompt identity while retaining a
  // durable conversation message as the authorization origin for control-plane calls.
  originMessageId?: string
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
}

export type ElicitationProjection = {
  message: string
  fields: ElicitationField[]
  state: 'pending' | 'answered' | 'declined' | 'cancelled'
  durable?: {
    kind: 'agent-user-choice'
    requestId: string
    promptMessageId?: string
    provenanceContext?: AgentTurnProvenanceContext
  }
  // Pending multi-question choices keep completed steps here so a restored Session resumes at the
  // first unanswered question. The Agent receives only `answers` after the user finishes the form.
  draftAnswers?: ElicitationAnswer[]
  answers?: ElicitationAnswer[]
  respondedAt?: number
}

export type PendingElicitationRequest = {
  requestId: string
  sessionId: string
  toolCallId: string
  message: string
  fields: ElicitationField[]
  durable?: ElicitationProjection['durable']
}

export const isDurableAgentUserChoiceRequest = (
  request: PendingElicitationRequest
): request is PendingElicitationRequest & {
  durable: NonNullable<ElicitationProjection['durable']>
} => request.durable?.kind === 'agent-user-choice'

export type ElicitationResponse = {
  requestId: string
  action: 'accept' | 'decline' | 'cancel'
  answers?: ElicitationAnswer[]
  // Re-answering a durable question rewinds the active conversation Branch before Main schedules
  // the replacement hidden continuation. This flag is renderer intent, never persisted.
  replacePreviousAnswer?: boolean
  // Durable choices echo their bounded projection so Main can rehydrate it after a restart.
  request?: PendingElicitationRequest
}

export type AgentUserChoiceOption = {
  label: string
  description?: string
}

export type AgentUserChoicePrompt = {
  question: string
  header?: string
  options: AgentUserChoiceOption[]
}

export type AgentUserChoiceRequest = {
  sessionId: string
  questions: AgentUserChoicePrompt[]
}

export type AgentUserChoiceResult =
  | { action: 'pending' }
  | { action: 'answered'; answer: string }
  | { action: 'skipped' }
  | { action: 'cancelled' }

const ELICITATION_STATES = new Set<ElicitationProjection['state']>([
  'pending',
  'answered',
  'declined',
  'cancelled'
])
const ELICITATION_FIELD_KINDS = new Set<ElicitationField['kind']>([
  'text',
  'single-select',
  'multi-select',
  'number',
  'integer',
  'boolean'
])

export const MAX_ELICITATION_MESSAGE_CHARS = 4_000
export const MAX_ELICITATION_LABEL_CHARS = 1_000
export const MAX_ELICITATION_FIELDS = 16
export const MAX_ELICITATION_OPTIONS_PER_FIELD = 64
export const MAX_ELICITATION_ANSWERS = 16
export const MAX_ELICITATION_MULTI_SELECT_VALUES = 64
export const MIN_AGENT_USER_CHOICE_OPTIONS = 2
export const MAX_AGENT_USER_CHOICE_OPTIONS = 4
export const MAX_AGENT_USER_CHOICE_QUESTIONS = 3
export const MAX_AGENT_TURN_PROVENANCE_ANCESTRY = 256

const isValidCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

const isValidFormattedString = (format: ElicitationField['format'], value: string): boolean => {
  if (!format) return true
  if (format === 'email') return /^[^\s@]+@[^\s@]+$/.test(value)
  if (format === 'uri') {
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  }
  if (format === 'date') return isValidCalendarDate(value)

  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    )
  if (!match || !isValidCalendarDate(match[1])) return false
  const hour = Number(match[2])
  const minute = Number(match[3])
  const second = Number(match[4])
  const offsetHour = match[6] === undefined ? 0 : Number(match[6])
  const offsetMinute = match[7] === undefined ? 0 : Number(match[7])
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
}

export const isValidElicitationValue = (
  field: ElicitationField,
  value: unknown
): value is ElicitationValue => {
  if (field.kind === 'text' || field.kind === 'single-select') {
    if (typeof value !== 'string') return false
    if (value.length > MAX_ELICITATION_MESSAGE_CHARS) return false
    if (field.minLength !== undefined && value.length < field.minLength) return false
    if (field.maxLength !== undefined && value.length > field.maxLength) return false
    if (field.options && !field.options.some((option) => option.value === value)) return false
    return isValidFormattedString(field.format, value)
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (field.kind === 'integer' && !Number.isInteger(value)) return false
    if (field.minimum !== undefined && value < field.minimum) return false
    if (field.maximum !== undefined && value > field.maximum) return false
    return true
  }
  if (field.kind === 'boolean') return typeof value === 'boolean'
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return false
  if (value.length > MAX_ELICITATION_MULTI_SELECT_VALUES) return false
  if (field.minItems !== undefined && value.length < field.minItems) return false
  if (field.maxItems !== undefined && value.length > field.maxItems) return false
  const allowed = new Set(field.options?.map((option) => option.value) ?? [])
  return value.every((item) => allowed.has(item))
}

const resolveAgentUserChoiceQuestion = (
  choiceField: ElicitationField,
  customField: ElicitationField
): AgentUserChoiceQuestion | undefined => {
  const isChoiceField =
    (choiceField.kind === 'single-select' || choiceField.kind === 'multi-select') &&
    Boolean(choiceField.options?.length) &&
    (choiceField.options?.length ?? 0) <= MAX_AGENT_USER_CHOICE_OPTIONS &&
    !choiceField.required &&
    choiceField.minLength === undefined &&
    choiceField.maxLength === undefined &&
    choiceField.minItems === undefined &&
    choiceField.maxItems === undefined &&
    choiceField.defaultValue === undefined

  if (
    !/^question_\d+$/u.test(choiceField.id) ||
    customField.id !== `${choiceField.id}_custom` ||
    !isChoiceField ||
    customField.kind !== 'text' ||
    customField.required ||
    customField.format !== undefined ||
    customField.minLength !== undefined ||
    customField.maxLength !== undefined ||
    customField.defaultValue !== undefined
  ) {
    return undefined
  }

  return { choiceField, customField }
}

// Claude Code's built-in AskUserQuestion and the app-owned cross-framework choice tool both use
// ordered `question_N` + `question_N_custom` pairs. Keep recognition shared by Main and Renderer so
// a provider-native choice cannot silently fall back to the generic ACP form or lose durability.
export const resolveAgentUserChoiceQuestions = (
  fields: ElicitationField[]
): AgentUserChoiceQuestion[] | undefined => {
  if (fields.length === 0 || fields.length % 2 !== 0) return undefined

  const questions: AgentUserChoiceQuestion[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const question = resolveAgentUserChoiceQuestion(fields[index], fields[index + 1])
    if (!question) return undefined
    questions.push(question)
  }
  return questions
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cappedString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, max) : undefined
}

const cappedDataString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.slice(0, max)
}

const boundedDataString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value : undefined

const boundedString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && value.length <= max ? text : undefined
}

export const sanitizeAgentUserChoiceRequest = (
  value: unknown
): AgentUserChoiceRequest | undefined => {
  if (!isRecord(value)) return undefined
  const sessionId = boundedString(value.sessionId, MAX_ELICITATION_LABEL_CHARS)
  const candidates = Array.isArray(value.questions) ? value.questions : [value]
  if (
    !sessionId ||
    candidates.length === 0 ||
    candidates.length > MAX_AGENT_USER_CHOICE_QUESTIONS
  ) {
    return undefined
  }

  const questions = candidates.flatMap((candidate): AgentUserChoicePrompt[] => {
    if (!isRecord(candidate)) return []
    const question = boundedString(candidate.question, MAX_ELICITATION_MESSAGE_CHARS)
    const header =
      candidate.header === undefined
        ? undefined
        : boundedString(candidate.header, MAX_ELICITATION_LABEL_CHARS)
    if (!question || (candidate.header !== undefined && !header)) return []
    if (
      !Array.isArray(candidate.options) ||
      candidate.options.length < MIN_AGENT_USER_CHOICE_OPTIONS ||
      candidate.options.length > MAX_AGENT_USER_CHOICE_OPTIONS
    ) {
      return []
    }

    const options = candidate.options.flatMap((option): AgentUserChoiceOption[] => {
      if (!isRecord(option)) return []
      const label = boundedString(option.label, MAX_ELICITATION_LABEL_CHARS)
      const description =
        option.description === undefined
          ? undefined
          : boundedString(option.description, MAX_ELICITATION_MESSAGE_CHARS)
      if (!label || (option.description !== undefined && !description)) return []
      return [{ label, ...(description ? { description } : {}) }]
    })
    if (
      options.length !== candidate.options.length ||
      new Set(options.map((option) => option.label)).size !== options.length
    ) {
      return []
    }

    return [{ question, ...(header ? { header } : {}), options }]
  })

  return questions.length === candidates.length ? { sessionId, questions } : undefined
}

const sanitizeOption = (value: unknown): ElicitationOption | undefined => {
  if (!isRecord(value)) return undefined
  const optionValue = boundedDataString(value.value, MAX_ELICITATION_LABEL_CHARS)
  const label = cappedString(value.label, MAX_ELICITATION_LABEL_CHARS)
  if (!optionValue || !label) return undefined

  const description = cappedString(value.description, MAX_ELICITATION_MESSAGE_CHARS)
  return { value: optionValue, label, ...(description ? { description } : {}) }
}

const withSanitizedDefault = (
  field: ElicitationField,
  value: Record<string, unknown>
): ElicitationField =>
  value.defaultValue !== undefined && isValidElicitationValue(field, value.defaultValue)
    ? { ...field, defaultValue: value.defaultValue }
    : field

export const sanitizeElicitationField = (value: unknown): ElicitationField | undefined => {
  if (!isRecord(value)) return undefined
  const id = boundedDataString(value.id, MAX_ELICITATION_LABEL_CHARS)
  const label = cappedString(value.label, MAX_ELICITATION_LABEL_CHARS)
  const kind = value.kind as ElicitationField['kind'] | undefined
  if (!id || !label || !kind || !ELICITATION_FIELD_KINDS.has(kind)) return undefined

  const description = cappedString(value.description, MAX_ELICITATION_MESSAGE_CHARS)
  const options = Array.isArray(value.options) ? value.options.map(sanitizeOption) : undefined
  if (
    value.options !== undefined &&
    (!options ||
      options.length === 0 ||
      options.length > MAX_ELICITATION_OPTIONS_PER_FIELD ||
      options.some((option) => !option) ||
      new Set(options.map((option) => option!.value)).size !== options.length)
  ) {
    return undefined
  }
  const sanitizedOptions = options as ElicitationOption[] | undefined
  const format =
    value.format === 'email' ||
    value.format === 'uri' ||
    value.format === 'date' ||
    value.format === 'date-time'
      ? value.format
      : undefined
  if (value.format !== undefined && !format) return undefined
  const finiteNumber = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
  const nonNegativeInteger = (candidate: unknown): number | undefined => {
    const number = finiteNumber(candidate)
    return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined
  }
  const minLength = nonNegativeInteger(value.minLength)
  const maxLength = nonNegativeInteger(value.maxLength)
  const minimum = finiteNumber(value.minimum)
  const maximum = finiteNumber(value.maximum)
  const minItems = nonNegativeInteger(value.minItems)
  const maxItems = nonNegativeInteger(value.maxItems)
  if (
    (value.minLength !== undefined && minLength === undefined) ||
    (value.maxLength !== undefined && maxLength === undefined) ||
    (value.minimum !== undefined && minimum === undefined) ||
    (value.maximum !== undefined && maximum === undefined) ||
    (value.minItems !== undefined && minItems === undefined) ||
    (value.maxItems !== undefined && maxItems === undefined)
  ) {
    return undefined
  }

  const common = {
    id,
    label,
    ...(description ? { description } : {}),
    ...(value.required === true ? { required: true } : {})
  }
  const hasNumericConstraints = minimum !== undefined || maximum !== undefined
  const hasLengthConstraints = minLength !== undefined || maxLength !== undefined
  const hasItemConstraints = minItems !== undefined || maxItems !== undefined

  if (kind === 'text' || kind === 'single-select') {
    if (
      hasNumericConstraints ||
      hasItemConstraints ||
      (minLength !== undefined && minLength > MAX_ELICITATION_MESSAGE_CHARS) ||
      (minLength !== undefined && maxLength !== undefined && minLength > maxLength) ||
      (value.required === true && maxLength === 0) ||
      (kind === 'text' && sanitizedOptions !== undefined) ||
      (kind === 'single-select' && sanitizedOptions === undefined)
    ) {
      return undefined
    }
    const field: ElicitationField = {
      ...common,
      kind,
      ...(sanitizedOptions ? { options: sanitizedOptions } : {}),
      ...(format ? { format } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {})
    }
    if (
      kind === 'single-select' &&
      !sanitizedOptions!.every((option) => isValidElicitationValue(field, option.value))
    ) {
      return undefined
    }
    return withSanitizedDefault(field, value)
  }

  if (kind === 'number' || kind === 'integer') {
    if (
      sanitizedOptions !== undefined ||
      format !== undefined ||
      hasLengthConstraints ||
      hasItemConstraints ||
      (minimum !== undefined && maximum !== undefined && minimum > maximum) ||
      (kind === 'integer' &&
        minimum !== undefined &&
        maximum !== undefined &&
        Math.ceil(minimum) > Math.floor(maximum))
    ) {
      return undefined
    }
    const field: ElicitationField = {
      ...common,
      kind,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {})
    }
    return withSanitizedDefault(field, value)
  }

  if (kind === 'boolean') {
    if (
      sanitizedOptions !== undefined ||
      format !== undefined ||
      hasLengthConstraints ||
      hasNumericConstraints ||
      hasItemConstraints
    ) {
      return undefined
    }
    return withSanitizedDefault({ ...common, kind }, value)
  }

  if (
    sanitizedOptions === undefined ||
    format !== undefined ||
    hasLengthConstraints ||
    hasNumericConstraints ||
    (minItems !== undefined && minItems > MAX_ELICITATION_MULTI_SELECT_VALUES) ||
    (minItems !== undefined && maxItems !== undefined && minItems > maxItems) ||
    (minItems !== undefined && minItems > sanitizedOptions.length) ||
    (value.required === true && maxItems === 0)
  ) {
    return undefined
  }
  const field: ElicitationField = {
    ...common,
    kind: 'multi-select',
    options: sanitizedOptions,
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {})
  }
  return withSanitizedDefault(field, value)
}

const sanitizeFields = (value: unknown): ElicitationField[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ELICITATION_FIELDS) {
    return undefined
  }
  const fields = value.map(sanitizeElicitationField)
  if (
    fields.some((field) => !field) ||
    new Set(fields.map((field) => field!.id)).size !== fields.length
  ) {
    return undefined
  }
  return fields as ElicitationField[]
}

const sanitizeAnswerValue = (value: unknown): ElicitationValue | undefined => {
  if (typeof value === 'string') return value.slice(0, MAX_ELICITATION_MESSAGE_CHARS)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value
      .slice(0, MAX_ELICITATION_MULTI_SELECT_VALUES)
      .map((item) => item.slice(0, MAX_ELICITATION_LABEL_CHARS))
  }
  return undefined
}

const sanitizeAnswer = (value: unknown): ElicitationAnswer | undefined => {
  if (!isRecord(value)) return undefined
  const fieldId = cappedDataString(value.fieldId, MAX_ELICITATION_LABEL_CHARS)
  const answerValue = sanitizeAnswerValue(value.value)
  return fieldId && answerValue !== undefined ? { fieldId, value: answerValue } : undefined
}

const sanitizeProvenanceAncestry = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_AGENT_TURN_PROVENANCE_ANCESTRY) return undefined
  const ancestry = value.map((candidate) => boundedString(candidate, MAX_ELICITATION_LABEL_CHARS))
  return ancestry.every((candidate): candidate is string => candidate !== undefined)
    ? ancestry
    : undefined
}

const sanitizeAgentTurnProvenanceContext = (
  value: unknown
): AgentTurnProvenanceContext | undefined => {
  if (!isRecord(value)) return undefined
  const promptMessageId = boundedString(value.promptMessageId, MAX_ELICITATION_LABEL_CHARS)
  if (!promptMessageId) return undefined

  const optionalIds = [
    'originMessageId',
    'rootFrameId',
    'agentFrameId',
    'messageBranchId',
    'runtimeSegmentId'
  ] as const
  const ids = Object.fromEntries(
    optionalIds.map((key) => [
      key,
      value[key] === undefined ? undefined : boundedString(value[key], MAX_ELICITATION_LABEL_CHARS)
    ])
  ) as Record<(typeof optionalIds)[number], string | undefined>
  if (optionalIds.some((key) => value[key] !== undefined && !ids[key])) return undefined

  const messageBranchAncestry =
    value.messageBranchAncestry === undefined
      ? undefined
      : sanitizeProvenanceAncestry(value.messageBranchAncestry)
  const messageAncestry =
    value.messageAncestry === undefined
      ? undefined
      : sanitizeProvenanceAncestry(value.messageAncestry)
  if (
    (value.messageBranchAncestry !== undefined && !messageBranchAncestry) ||
    (value.messageAncestry !== undefined && !messageAncestry)
  ) {
    return undefined
  }

  return {
    promptMessageId,
    ...(ids.originMessageId ? { originMessageId: ids.originMessageId } : {}),
    ...(ids.rootFrameId ? { rootFrameId: ids.rootFrameId } : {}),
    ...(ids.agentFrameId ? { agentFrameId: ids.agentFrameId } : {}),
    ...(ids.messageBranchId ? { messageBranchId: ids.messageBranchId } : {}),
    ...(messageBranchAncestry ? { messageBranchAncestry } : {}),
    ...(messageAncestry ? { messageAncestry } : {}),
    ...(ids.runtimeSegmentId ? { runtimeSegmentId: ids.runtimeSegmentId } : {})
  }
}

const sanitizeDurableElicitation = (
  value: unknown
): ElicitationProjection['durable'] | undefined => {
  if (!isRecord(value) || value.kind !== 'agent-user-choice') return undefined
  const requestId = boundedString(value.requestId, MAX_ELICITATION_LABEL_CHARS)
  const promptMessageId =
    value.promptMessageId === undefined
      ? undefined
      : boundedString(value.promptMessageId, MAX_ELICITATION_LABEL_CHARS)
  const provenanceContext = sanitizeAgentTurnProvenanceContext(value.provenanceContext)
  if (
    !requestId ||
    (value.promptMessageId !== undefined && !promptMessageId) ||
    (value.provenanceContext !== undefined && !provenanceContext)
  ) {
    return undefined
  }
  return {
    kind: 'agent-user-choice',
    requestId,
    ...(promptMessageId ? { promptMessageId } : {}),
    ...(provenanceContext ? { provenanceContext } : {})
  }
}

export const sanitizePendingElicitationRequest = (
  value: unknown
): PendingElicitationRequest | undefined => {
  if (!isRecord(value) || !Array.isArray(value.fields)) return undefined
  const requestId = boundedString(value.requestId, MAX_ELICITATION_LABEL_CHARS)
  const sessionId = boundedString(value.sessionId, MAX_ELICITATION_LABEL_CHARS)
  const toolCallId = boundedString(value.toolCallId, MAX_ELICITATION_LABEL_CHARS)
  const message = boundedString(value.message, MAX_ELICITATION_MESSAGE_CHARS)
  const fields = sanitizeFields(value.fields)
  const durable = sanitizeDurableElicitation(value.durable)
  if (
    !requestId ||
    !sessionId ||
    !toolCallId ||
    !message ||
    !fields ||
    (value.durable !== undefined && !durable) ||
    (durable && durable.requestId !== requestId)
  ) {
    return undefined
  }
  return {
    requestId,
    sessionId,
    toolCallId,
    message,
    fields,
    ...(durable ? { durable } : {})
  }
}

export const sanitizeElicitationProjection = (
  value: unknown
): ElicitationProjection | undefined => {
  if (!isRecord(value)) return undefined
  const message = cappedString(value.message, MAX_ELICITATION_MESSAGE_CHARS)
  const state = value.state as ElicitationProjection['state'] | undefined
  if (!message || !state || !ELICITATION_STATES.has(state) || !Array.isArray(value.fields)) {
    return undefined
  }

  const fields = sanitizeFields(value.fields)
  if (!fields) return undefined

  const answers = Array.isArray(value.answers)
    ? value.answers
        .slice(0, MAX_ELICITATION_ANSWERS)
        .map(sanitizeAnswer)
        .filter((answer): answer is ElicitationAnswer => !!answer)
    : undefined
  const draftAnswers = Array.isArray(value.draftAnswers)
    ? value.draftAnswers
        .slice(0, MAX_ELICITATION_ANSWERS)
        .map(sanitizeAnswer)
        .filter((answer): answer is ElicitationAnswer => !!answer)
    : undefined
  const respondedAt =
    typeof value.respondedAt === 'number' && Number.isFinite(value.respondedAt)
      ? value.respondedAt
      : undefined
  const durable = sanitizeDurableElicitation(value.durable)

  return {
    message,
    fields,
    state,
    ...(durable ? { durable } : {}),
    ...(state === 'pending' && draftAnswers && draftAnswers.length > 0 ? { draftAnswers } : {}),
    ...(answers && answers.length > 0 ? { answers } : {}),
    ...(respondedAt !== undefined ? { respondedAt } : {})
  }
}
