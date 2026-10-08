import type {
  PersistedToolActivityStatus,
  PersistedToolActivityDisposition,
  PersistedToolCallLocation,
  PersistedToolActivity,
  PersistedActivityGroup
} from './message'
import { asString, isRecord, asNumber, asStringArray } from './primitives'
import {
  sanitizeToolDetailText,
  sanitizeToolContent,
  sanitizeRawToolPayload,
  sanitizeNotebookCodeReviewPayload
} from '../tool-detail-sanitizer'
import { sanitizeElicitationProjection } from '../elicitation'
import { sanitizeActivityGroupTitle } from '../activity-groups'

const TOOL_ACTIVITY_STATUSES = new Set<PersistedToolActivityStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed'
])

const TOOL_ACTIVITY_DISPOSITIONS = new Set<PersistedToolActivityDisposition>([
  'declined',
  'permission-closed'
])

const MAX_PERSISTED_RAW_CHARS = 8_000

// Reads a bounded string field, returning undefined when empty.
const asCappedString = (value: unknown): string | undefined => {
  const text = asString(value)

  return text ? sanitizeToolDetailText(text) : undefined
}

// Rebuilds tool file locations from path/line fields only.
const sanitizeToolLocations = (value: unknown): PersistedToolCallLocation[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const locations = value
    .map((location): PersistedToolCallLocation | undefined => {
      if (!isRecord(location)) return undefined

      const path = asString(location.path)

      if (!path) return undefined

      const line = asNumber(location.line)

      return line !== undefined ? { path, line } : { path }
    })
    .filter((location): location is PersistedToolCallLocation => !!location)

  return locations.length > 0 ? locations : undefined
}

// Accepts only known tool-activity statuses, defaulting unknown values to completed.
const asToolActivityStatus = (value: unknown): PersistedToolActivityStatus => {
  const status = asString(value) as PersistedToolActivityStatus | undefined

  return status && TOOL_ACTIVITY_STATUSES.has(status) ? status : 'completed'
}

const asToolActivityDisposition = (
  value: unknown
): PersistedToolActivityDisposition | undefined => {
  const disposition = asString(value) as PersistedToolActivityDisposition | undefined
  return disposition && TOOL_ACTIVITY_DISPOSITIONS.has(disposition) ? disposition : undefined
}

const NOTEBOOK_RUN_TOOL_SUFFIXES = new Set(['notebook_execute', 'repl_execute', 'bash_execute'])

// Matches only the app-owned Notebook server identities emitted by supported ACP adapters.
// Restoration must fail closed: a lookalike provider tool is never reclassified as static code.
export const isPersistedNotebookRunActivity = (activity: PersistedToolActivity): boolean => {
  const names = [activity.providerToolName, activity.title]
  return names.some((candidate) => {
    const name = candidate?.trim().toLowerCase()
    if (!name) return false

    const segments = name.split(/__|\.|\//u)
    if (segments.length >= 2) {
      const tool = segments.at(-1)
      const server = segments.at(-2)?.replace(/_/gu, '-')
      if (server === 'open-science-notebook' && tool && NOTEBOOK_RUN_TOOL_SUFFIXES.has(tool)) {
        return true
      }
    }

    for (const tool of NOTEBOOK_RUN_TOOL_SUFFIXES) {
      if (name === `open-science-notebook_${tool}` || name === `open_science_notebook_${tool}`) {
        return true
      }
    }
    return false
  })
}

// Rebuilds a persisted tool activity from durable fields, bounding every large payload.
export const sanitizeToolActivity = (activity: unknown): PersistedToolActivity | undefined => {
  if (!isRecord(activity)) return undefined

  const id = asString(activity.id)

  if (!id) return undefined

  const sanitized: PersistedToolActivity = {
    id,
    kind: 'tool',
    title: asCappedString(activity.title) ?? '',
    status: asToolActivityStatus(activity.status),
    sortIndex: asNumber(activity.sortIndex) ?? 0,
    eventIds: asStringArray(activity.eventIds),
    createdAt: asNumber(activity.createdAt) ?? 0,
    updatedAt: asNumber(activity.updatedAt) ?? 0
  }
  const providerToolName = asString(activity.providerToolName)
  const activityGroupId = asString(activity.activityGroupId)
  const promptMessageId = asString(activity.promptMessageId)
  const toolKind = asString(activity.toolKind)
  const toolContent = sanitizeToolContent(activity.toolContent)
  const toolLocations = sanitizeToolLocations(activity.toolLocations)
  const rawInput =
    activity.appOwned === true &&
    id.startsWith('app-approval:') &&
    providerToolName === 'Open-Science'
      ? (sanitizeNotebookCodeReviewPayload(activity.rawInput) ??
        sanitizeRawToolPayload(activity.rawInput, MAX_PERSISTED_RAW_CHARS))
      : sanitizeRawToolPayload(activity.rawInput, MAX_PERSISTED_RAW_CHARS)
  const rawOutput = sanitizeRawToolPayload(activity.rawOutput, MAX_PERSISTED_RAW_CHARS)
  const terminalOutput = asCappedString(activity.terminalOutput)
  const terminalExitCode = asNumber(activity.terminalExitCode)
  const elicitation = sanitizeElicitationProjection(activity.elicitation)
  const toolDisposition = asToolActivityDisposition(activity.toolDisposition)
  const executionInvocationId = asString(activity.executionInvocationId)

  if (activity.appOwned === true) sanitized.appOwned = true
  if (providerToolName) sanitized.providerToolName = providerToolName
  if (activityGroupId) sanitized.activityGroupId = activityGroupId
  if (promptMessageId) sanitized.promptMessageId = promptMessageId
  if (toolKind) sanitized.toolKind = toolKind
  if (toolContent) sanitized.toolContent = toolContent
  if (toolLocations) sanitized.toolLocations = toolLocations
  if (rawInput !== undefined) sanitized.rawInput = rawInput
  if (rawOutput !== undefined) sanitized.rawOutput = rawOutput
  if (terminalOutput !== undefined) sanitized.terminalOutput = terminalOutput
  if (terminalExitCode !== undefined) sanitized.terminalExitCode = terminalExitCode
  if (elicitation) sanitized.elicitation = elicitation
  if (toolDisposition) sanitized.toolDisposition = toolDisposition
  if (executionInvocationId) sanitized.executionInvocationId = executionInvocationId

  return sanitized
}

export const sanitizeActivityGroup = (group: unknown): PersistedActivityGroup | undefined => {
  if (!isRecord(group)) return undefined

  const id = asString(group.id)
  const title = sanitizeActivityGroupTitle(group.title)
  if (!id || !title) return undefined

  const updatedAt = asNumber(group.updatedAt) ?? 0
  const completedAt = asNumber(group.completedAt)
  const promptMessageId = asString(group.promptMessageId)
  return {
    id,
    title,
    sortIndex: asNumber(group.sortIndex) ?? 0,
    activityIds: asStringArray(group.activityIds),
    ...(promptMessageId ? { promptMessageId } : {}),
    createdAt: asNumber(group.createdAt) ?? 0,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt })
  }
}
