import type { ArtifactMessageSnapshotFile } from '../../shared/artifact-provenance'
import type { ReviewScopeSnapshotBlock } from '../../shared/reviewer'
import {
  decodeVersionedJson,
  type VersionedJsonDecodeResult
} from '../storage/versioned-json-decoder'

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const readSchemaVersion = (value: unknown): unknown => recordValue(value)?.schemaVersion

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

const optionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))

const stringArrayValue = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const elicitationAnswerValue = (value: unknown): boolean =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  stringArrayValue(value)

const elicitationOptionValue = (value: unknown): boolean => {
  const option = recordValue(value)
  return (
    option !== undefined &&
    typeof option.value === 'string' &&
    typeof option.label === 'string' &&
    optionalString(option.description)
  )
}

const elicitationFieldValue = (value: unknown): boolean => {
  const field = recordValue(value)
  return (
    field !== undefined &&
    typeof field.id === 'string' &&
    typeof field.label === 'string' &&
    optionalString(field.description) &&
    (field.kind === 'text' ||
      field.kind === 'single-select' ||
      field.kind === 'multi-select' ||
      field.kind === 'number' ||
      field.kind === 'integer' ||
      field.kind === 'boolean') &&
    (field.required === undefined || typeof field.required === 'boolean') &&
    (field.options === undefined ||
      (Array.isArray(field.options) && field.options.every(elicitationOptionValue))) &&
    (field.format === undefined ||
      field.format === 'email' ||
      field.format === 'uri' ||
      field.format === 'date' ||
      field.format === 'date-time') &&
    optionalFiniteNumber(field.minLength) &&
    optionalFiniteNumber(field.maxLength) &&
    optionalFiniteNumber(field.minimum) &&
    optionalFiniteNumber(field.maximum) &&
    optionalFiniteNumber(field.minItems) &&
    optionalFiniteNumber(field.maxItems) &&
    (field.defaultValue === undefined || elicitationAnswerValue(field.defaultValue))
  )
}

const elicitationAnswerRecordValue = (value: unknown): boolean => {
  const answer = recordValue(value)
  return (
    answer !== undefined &&
    typeof answer.fieldId === 'string' &&
    elicitationAnswerValue(answer.value)
  )
}

const elicitationProvenanceContextValue = (value: unknown): boolean => {
  const context = recordValue(value)
  return (
    context !== undefined &&
    typeof context.promptMessageId === 'string' &&
    optionalString(context.originMessageId) &&
    optionalString(context.rootFrameId) &&
    optionalString(context.agentFrameId) &&
    optionalString(context.messageBranchId) &&
    optionalString(context.runtimeSegmentId) &&
    (context.messageBranchAncestry === undefined ||
      stringArrayValue(context.messageBranchAncestry)) &&
    (context.messageAncestry === undefined || stringArrayValue(context.messageAncestry))
  )
}

const elicitationDurableValue = (value: unknown): boolean => {
  const durable = recordValue(value)
  return (
    durable !== undefined &&
    durable.kind === 'agent-user-choice' &&
    typeof durable.requestId === 'string' &&
    optionalString(durable.promptMessageId) &&
    (durable.provenanceContext === undefined ||
      elicitationProvenanceContextValue(durable.provenanceContext))
  )
}

const elicitationValue = (value: unknown): boolean => {
  const elicitation = recordValue(value)
  return (
    elicitation !== undefined &&
    typeof elicitation.message === 'string' &&
    Array.isArray(elicitation.fields) &&
    elicitation.fields.length > 0 &&
    elicitation.fields.every(elicitationFieldValue) &&
    (elicitation.state === 'pending' ||
      elicitation.state === 'answered' ||
      elicitation.state === 'declined' ||
      elicitation.state === 'cancelled') &&
    (elicitation.durable === undefined || elicitationDurableValue(elicitation.durable)) &&
    (elicitation.draftAnswers === undefined ||
      (Array.isArray(elicitation.draftAnswers) &&
        elicitation.draftAnswers.every(elicitationAnswerRecordValue))) &&
    (elicitation.answers === undefined ||
      (Array.isArray(elicitation.answers) &&
        elicitation.answers.every(elicitationAnswerRecordValue))) &&
    optionalFiniteNumber(elicitation.respondedAt)
  )
}

const messagePartValue = (value: unknown): boolean => {
  const part = recordValue(value)
  if (!part) return false
  if (part.type === 'text') return typeof part.text === 'string'
  if (part.type === 'skill') return typeof part.name === 'string'
  return part.type === 'artifact' && typeof part.name === 'string' && optionalString(part.versionId)
}

const messageValue = (value: unknown): boolean => {
  const message = recordValue(value)
  if (
    !message ||
    typeof message.id !== 'string' ||
    (message.role !== 'user' && message.role !== 'agent') ||
    typeof message.content !== 'string' ||
    typeof message.createdAt !== 'number' ||
    !Number.isFinite(message.createdAt) ||
    !optionalString(message.parentMessageId) ||
    !optionalString(message.supersedesMessageId) ||
    (message.hasOmittedMedia !== undefined && typeof message.hasOmittedMedia !== 'boolean') ||
    (message.parts !== undefined &&
      (!Array.isArray(message.parts) || message.parts.some((part) => !messagePartValue(part)))) ||
    (message.artifacts !== undefined &&
      (!Array.isArray(message.artifacts) ||
        message.artifacts.some((artifact) => {
          const candidate = recordValue(artifact)
          return (
            !candidate || typeof candidate.name !== 'string' || !optionalString(candidate.versionId)
          )
        })))
  ) {
    return false
  }
  if (message.agentAttribution !== undefined) {
    const attribution = recordValue(message.agentAttribution)
    if (
      !attribution ||
      typeof attribution.frameworkId !== 'string' ||
      attribution.frameworkId.trim().length === 0 ||
      !optionalString(attribution.agentName) ||
      !optionalString(attribution.model)
    ) {
      return false
    }
  }
  return true
}

const activityValue = (value: unknown): boolean => {
  const activity = recordValue(value)
  const locationsAreValid =
    activity?.toolLocations === undefined ||
    (Array.isArray(activity.toolLocations) &&
      activity.toolLocations.every((location) => {
        const candidate = recordValue(location)
        return (
          candidate !== undefined &&
          typeof candidate.path === 'string' &&
          (candidate.line === undefined ||
            candidate.line === null ||
            (typeof candidate.line === 'number' && Number.isFinite(candidate.line)))
        )
      }))
  return (
    activity !== undefined &&
    typeof activity.id === 'string' &&
    activity.kind === 'tool' &&
    typeof activity.title === 'string' &&
    (activity.status === 'pending' ||
      activity.status === 'in_progress' ||
      activity.status === 'completed' ||
      activity.status === 'failed') &&
    typeof activity.sortIndex === 'number' &&
    Number.isFinite(activity.sortIndex) &&
    Array.isArray(activity.eventIds) &&
    activity.eventIds.every((eventId) => typeof eventId === 'string') &&
    optionalString(activity.activityGroupId) &&
    optionalString(activity.promptMessageId) &&
    optionalString(activity.executionInvocationId) &&
    optionalString(activity.providerToolName) &&
    optionalString(activity.toolKind) &&
    (activity.toolDisposition === undefined ||
      activity.toolDisposition === 'declined' ||
      activity.toolDisposition === 'permission-closed') &&
    (activity.toolContent === undefined || Array.isArray(activity.toolContent)) &&
    locationsAreValid &&
    optionalString(activity.terminalOutput) &&
    (activity.terminalExitCode === undefined ||
      activity.terminalExitCode === null ||
      (typeof activity.terminalExitCode === 'number' &&
        Number.isFinite(activity.terminalExitCode))) &&
    (activity.elicitation === undefined || elicitationValue(activity.elicitation)) &&
    typeof activity.createdAt === 'number' &&
    Number.isFinite(activity.createdAt) &&
    typeof activity.updatedAt === 'number' &&
    Number.isFinite(activity.updatedAt)
  )
}

const activityGroupValue = (value: unknown): boolean => {
  const group = recordValue(value)
  return (
    group !== undefined &&
    typeof group.id === 'string' &&
    typeof group.title === 'string' &&
    typeof group.sortIndex === 'number' &&
    Number.isFinite(group.sortIndex) &&
    Array.isArray(group.activityIds) &&
    group.activityIds.every((activityId) => typeof activityId === 'string') &&
    optionalString(group.promptMessageId) &&
    typeof group.createdAt === 'number' &&
    Number.isFinite(group.createdAt) &&
    typeof group.updatedAt === 'number' &&
    Number.isFinite(group.updatedAt) &&
    (group.completedAt === undefined ||
      (typeof group.completedAt === 'number' && Number.isFinite(group.completedAt)))
  )
}

const messageSnapshotValue = (value: unknown): ArtifactMessageSnapshotFile | undefined => {
  const snapshot = recordValue(value)
  if (
    !snapshot ||
    (snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) ||
    typeof snapshot.snapshotId !== 'string' ||
    typeof snapshot.rootFrameId !== 'string' ||
    typeof snapshot.agentFrameId !== 'string' ||
    typeof snapshot.messageBranchId !== 'string' ||
    typeof snapshot.terminalMessageId !== 'string' ||
    typeof snapshot.createdAt !== 'string' ||
    !Array.isArray(snapshot.messages) ||
    snapshot.messages.some((message) => !messageValue(message)) ||
    (snapshot.schemaVersion === 3 &&
      (!Array.isArray(snapshot.activities) ||
        snapshot.activities.some((activity) => !activityValue(activity)) ||
        !Array.isArray(snapshot.activityGroups) ||
        snapshot.activityGroups.some((group) => !activityGroupValue(group))))
  ) {
    return undefined
  }
  return value as ArtifactMessageSnapshotFile
}

const decodeArtifactMessageSnapshot = (
  value: string
): VersionedJsonDecodeResult<ArtifactMessageSnapshotFile> =>
  decodeVersionedJson(value, {
    currentVersion: 3,
    legacyVersions: [2],
    readVersion: readSchemaVersion,
    decode: messageSnapshotValue
  })

const reviewScopeSnapshotValue = (value: unknown): ReviewScopeSnapshotBlock[] | undefined => {
  const snapshot = recordValue(value)
  return snapshot &&
    Array.isArray(snapshot.blocks) &&
    snapshot.blocks.every((block) => {
      const candidate = recordValue(block)
      return (
        candidate !== undefined &&
        Number.isSafeInteger(candidate.blockIndex) &&
        Number(candidate.blockIndex) >= 0 &&
        typeof candidate.id === 'string' &&
        (candidate.kind === 'message' || candidate.kind === 'activity') &&
        typeof candidate.sourceId === 'string' &&
        typeof candidate.contentHash === 'string' &&
        recordValue(candidate.payload) !== undefined
      )
    })
    ? (snapshot.blocks as ReviewScopeSnapshotBlock[])
    : undefined
}

const decodeReviewScopeSnapshot = (
  value: string
): VersionedJsonDecodeResult<ReviewScopeSnapshotBlock[]> =>
  decodeVersionedJson(value, {
    currentVersion: 2,
    legacyVersions: [1],
    readVersion: readSchemaVersion,
    decode: reviewScopeSnapshotValue
  })

export { decodeArtifactMessageSnapshot, decodeReviewScopeSnapshot }
