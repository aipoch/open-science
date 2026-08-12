import {
  isAppIconVariant,
  isReasoningEffort,
  type AppIconVariant,
  type ProjectFilesFilterPreference,
  type ReasoningEffort,
  type SubagentModelConfiguration
} from '../../shared/settings'
import type { CloseActionPreference } from '../../shared/window-controls'
import { isPermissionProfileId, type PermissionProfileId } from '../../shared/permission-profiles'

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

const readReasoningEffort = (request: unknown): ReasoningEffort => {
  const effort = readField(request, 'effort')
  if (!isReasoningEffort(effort)) {
    throw new Error(`Unknown reasoning effort: ${String(effort)}`)
  }
  return effort
}

const readSubagentModel = (request: unknown): SubagentModelConfiguration => {
  const configuration = readField(request, 'configuration')
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error('Invalid Subagent model configuration.')
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
  throw new Error('Invalid Subagent model configuration.')
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
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readGitHubToken,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readProjectFilesFilter,
  readReasoningEffort,
  readSubagentModel
}
