import {
  isAppIconVariant,
  isReasoningEffort,
  type AppIconVariant,
  type ProjectFilesFilterPreference,
  type ReasoningEffort,
  type SetAgentRoutingRequest,
  type ReviewerModelConfiguration,
  type SessionDetailsModelConfiguration,
  type SubagentModelConfiguration,
  type VisionModelConfiguration
} from '../../shared/settings'
import type { CloseActionPreference } from '../../shared/window-controls'
import { isPermissionProfileId, type PermissionProfileId } from '../../shared/permission-profiles'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'

const readField = (value: unknown, field: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[field]
    : undefined

const readNotificationsEnabled = (request: unknown): boolean => {
  const enabled = readField(request, 'enabled')
  if (typeof enabled !== 'boolean') {
    throw new Error(`Invalid notifications-enabled flag: ${String(enabled)}`)
  }
  return enabled
}

const readShowNotificationContent = (request: unknown): boolean => {
  const enabled = readField(request, 'enabled')
  if (typeof enabled !== 'boolean') {
    throw new Error(`Invalid show-notification-content flag: ${String(enabled)}`)
  }
  return enabled
}

const readReasoningEffort = (request: unknown): ReasoningEffort => {
  const effort = readField(request, 'effort')
  if (!isReasoningEffort(effort)) {
    throw new Error(`Unknown reasoning effort: ${String(effort)}`)
  }
  return effort
}

const readModelConfiguration = (
  request: unknown,
  label: 'Subagent' | 'Reviewer'
): SubagentModelConfiguration => {
  const configuration = readField(request, 'configuration')
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error(`Invalid ${label} model configuration.`)
  }
  const value = configuration as Record<string, unknown>
  if (value.mode === 'inherit' && Object.keys(value).length === 1) return { mode: 'inherit' }
  if (
    value.mode === 'fixed' &&
    Object.keys(value).every((key) =>
      ['mode', 'providerId', 'model', 'reasoningEffort'].includes(key)
    ) &&
    Object.keys(value).length === 4 &&
    typeof value.providerId === 'string' &&
    value.providerId.trim() !== '' &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    isReasoningEffort(value.reasoningEffort)
  ) {
    return {
      mode: 'fixed',
      providerId: value.providerId,
      model: value.model,
      reasoningEffort: value.reasoningEffort
    }
  }
  throw new Error(`Invalid ${label} model configuration.`)
}

const readSubagentModel = (request: unknown): SubagentModelConfiguration =>
  readModelConfiguration(request, 'Subagent')

const readReviewerModel = (request: unknown): ReviewerModelConfiguration =>
  readModelConfiguration(request, 'Reviewer')

const readAgentRouting = (request: unknown): SetAgentRoutingRequest => {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('Invalid Agent routing update.')
  }
  const value = request as Record<string, unknown>
  if (!Object.keys(value).every((key) => ['framework', 'reviewer', 'subagent'].includes(key))) {
    throw new Error('Invalid Agent routing update.')
  }
  if (
    value.framework !== undefined &&
    !['claude-code', 'opencode', 'codex', 'codebuddy'].includes(String(value.framework))
  ) {
    throw new Error(`Unknown Agent Framework: ${String(value.framework)}`)
  }
  return {
    ...(value.framework !== undefined
      ? { framework: value.framework as SetAgentRoutingRequest['framework'] }
      : {}),
    ...(value.reviewer !== undefined
      ? { reviewer: readModelConfiguration({ configuration: value.reviewer }, 'Reviewer') }
      : {}),
    ...(value.subagent !== undefined
      ? { subagent: readModelConfiguration({ configuration: value.subagent }, 'Subagent') }
      : {})
  }
}

const readSessionDetailsModel = (request: unknown): SessionDetailsModelConfiguration => {
  const configuration = readField(request, 'configuration')
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error('Invalid Session details model configuration.')
  }
  const value = configuration as Record<string, unknown>
  if (value.mode === 'disabled' && Object.keys(value).length === 1) return { mode: 'disabled' }
  if (
    value.mode === 'inherit' &&
    Object.keys(value).length === 2 &&
    isReasoningEffort(value.reasoningEffort)
  ) {
    return { mode: 'inherit', reasoningEffort: value.reasoningEffort }
  }
  if (
    value.mode === 'fixed' &&
    Object.keys(value).length === 4 &&
    typeof value.providerId === 'string' &&
    value.providerId.trim() !== '' &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    isReasoningEffort(value.reasoningEffort)
  ) {
    return {
      mode: 'fixed',
      providerId: value.providerId,
      model: value.model,
      reasoningEffort: value.reasoningEffort
    }
  }
  throw new Error('Invalid Session details model configuration.')
}

const readVisionModel = (request: unknown): VisionModelConfiguration | undefined => {
  const configuration = readField(request, 'configuration')
  if (configuration === undefined) return undefined
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error('Invalid Vision model configuration.')
  }
  const value = configuration as Record<string, unknown>
  if (
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => ['providerId', 'model', 'reasoningEffort'].includes(key)) &&
    typeof value.providerId === 'string' &&
    value.providerId.trim() !== '' &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    isReasoningEffort(value.reasoningEffort)
  ) {
    return {
      providerId: value.providerId,
      model: value.model,
      reasoningEffort: value.reasoningEffort
    }
  }
  throw new Error('Invalid Vision model configuration.')
}

const readConversationSkillImportEnabled = (request: unknown): boolean => {
  const enabled = readField(request, 'enabled')
  if (typeof enabled !== 'boolean') {
    throw new Error(`Invalid conversation-skill-import-enabled flag: ${String(enabled)}`)
  }
  return enabled
}

const readClosePreference = (request: unknown): CloseActionPreference | undefined => {
  const preference = readField(request, 'preference')
  if (preference !== undefined && preference !== 'minimize' && preference !== 'quit') {
    throw new Error(`Invalid close preference: ${String(preference)}`)
  }
  return preference
}

const readAppIconVariant = (request: unknown): AppIconVariant => {
  const variant = readField(request, 'variant')
  if (!isAppIconVariant(variant)) {
    throw new Error(`Unknown app icon variant: ${String(variant)}`)
  }
  return variant
}

const readProjectFilesFilter = (request: unknown): ProjectFilesFilterPreference | undefined => {
  const filter = readField(request, 'filter')
  if (filter === undefined) return undefined
  if (typeof filter !== 'object' || filter === null) {
    throw new Error(`Invalid project files filter: ${String(filter)}`)
  }

  const sourceMode = readField(filter, 'sourceMode')
  if (sourceMode !== 'artifacts' && sourceMode !== 'local') {
    throw new Error(`Invalid project files filter source: ${String(sourceMode)}`)
  }

  const optionId = readField(filter, 'optionId')
  const localRootId = readField(filter, 'localRootId')
  if (optionId !== undefined && typeof optionId !== 'string') {
    throw new Error(`Invalid project files filter option: ${String(optionId)}`)
  }
  if (localRootId !== undefined && typeof localRootId !== 'string') {
    throw new Error(`Invalid project files filter root: ${String(localRootId)}`)
  }

  return {
    sourceMode,
    ...(optionId === undefined ? {} : { optionId }),
    ...(localRootId === undefined ? {} : { localRootId })
  }
}

const readDefaultPermissionProfile = (request: unknown): PermissionProfileId => {
  const profile = readField(request, 'profile')
  if (!isPermissionProfileId(profile)) {
    throw new Error(`Unknown default permission profile: ${String(profile)}`)
  }
  return profile
}

const readIsolatedClaudeToken = (token: unknown): string => {
  if (typeof token !== 'string') {
    throw new Error('Claude sign-in token must be a string.')
  }
  if (Buffer.byteLength(token, 'utf8') > PROVIDER_RESOURCE_LIMITS.apiKeyBytes) {
    throw new Error(
      `Claude sign-in token must not exceed ${PROVIDER_RESOURCE_LIMITS.apiKeyBytes} bytes.`
    )
  }
  return token
}

const readGitHubToken = (request: unknown): string => {
  const token = readField(request, 'token')
  if (typeof token !== 'string' || token.trim().length === 0 || token.length > 1024) {
    throw new Error('GitHub token must be a non-empty string no longer than 1024 characters.')
  }
  return token.trim()
}

export {
  readAppIconVariant,
  readAgentRouting,
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readGitHubToken,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readShowNotificationContent,
  readProjectFilesFilter,
  readReasoningEffort,
  readReviewerModel,
  readSessionDetailsModel,
  readSubagentModel,
  readVisionModel
}
