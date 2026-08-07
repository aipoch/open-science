import {
  isAppIconVariant,
  isReasoningEffort,
  type AppIconVariant,
  type ReasoningEffort
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

export {
  readAppIconVariant,
  readClosePreference,
  readConversationSkillImportEnabled,
  readDefaultPermissionProfile,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readReasoningEffort
}
