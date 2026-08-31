import { isAbsolute, normalize, parse } from 'node:path'

import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  SETTINGS_FILE_VERSION,
  codexSubscriptionProviderIdentity,
  DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  isAppIconVariant,
  isClaudeSubscriptionProvider,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  isReasoningEffort,
  type SessionDetailsModelConfiguration,
  type SubagentModelConfiguration,
  type VisionModelConfiguration
} from '../../shared/settings'
import { isPermissionProfileId } from '../../shared/permission-profiles'
import { isLanguagePreference } from '../../shared/locale'
import { normalizeNetworkProxySettings } from '../../shared/network-proxy'
import { normalizeNotebookNetworkSettings } from '../../shared/notebook-network'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import type { ProjectFilesFilterPreference } from '../../shared/settings'
import {
  createEmptySettings,
  type StoredComputeGrant,
  type StoredProvider,
  type StoredSettings
} from './types'
import {
  sanitizeClaudeInfo,
  sanitizeCodexInfo,
  sanitizeComputeGrant,
  sanitizeConnectors,
  sanitizePackageMirror,
  sanitizeProvider
} from './record-codec'
import { isRecord } from '../value-guards'

// Checks for plain JSON objects so untrusted settings payloads can be sanitized safely.
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

// Rebuilds one legacy granted local root, dropping records with missing required fields or an
// unknown access level. Kept only for the one-time import into the GrantedLocalRoot table.
const sanitizeGrantedLocalRoot = (value: unknown): GrantedLocalRoot | undefined => {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  const path = asString(value.path)
  const name = asString(value.name)
  const access = asString(value.access)
  if (!id || !path || !name || (access !== 'ro' && access !== 'rw')) return undefined
  return { id, path, name, access }
}

// Rebuilds the persisted Files-tab source filter from untrusted JSON. Returns undefined unless a
// known sourceMode survives; the optional ids are kept only as plain strings.
const sanitizeProjectFilesFilter = (value: unknown): ProjectFilesFilterPreference | undefined => {
  if (!isRecord(value)) return undefined

  const sourceMode = asString(value.sourceMode)
  if (sourceMode !== 'artifacts' && sourceMode !== 'local') return undefined

  const optionId = asString(value.optionId)
  const localRootId = asString(value.localRootId)
  return {
    sourceMode,
    ...(optionId === undefined ? {} : { optionId }),
    ...(localRootId === undefined ? {} : { localRootId })
  }
}

// Rebuilds a record<string,boolean>, dropping any key whose value isn't a boolean. Returns an empty
// record (never undefined) for a non-record input so callers get a stable, always-mergeable map.
const asBooleanRecord = (value: unknown): Record<string, boolean> => {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
  )
  return Object.fromEntries(entries)
}

const sanitizeSubagentModel = (value: unknown): SubagentModelConfiguration => {
  if (!isRecord(value) || value.mode === 'inherit') return { mode: 'inherit' }
  if (value.mode === 'fixed') {
    const providerId = asString(value.providerId)
    const model = asString(value.model)
    const reasoningEffort = asString(value.reasoningEffort)
    if (providerId && model && isReasoningEffort(reasoningEffort)) {
      return { mode: 'fixed', providerId, model, reasoningEffort }
    }
  }
  return { mode: 'inherit' }
}

const sanitizeSessionDetailsModel = (value: unknown): SessionDetailsModelConfiguration => {
  if (!isRecord(value)) return DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION
  if (
    value.mode === 'inherit' &&
    Object.keys(value).length === 2 &&
    isReasoningEffort(value.reasoningEffort)
  ) {
    return { mode: 'inherit', reasoningEffort: value.reasoningEffort }
  }
  if (value.mode === 'disabled' && Object.keys(value).length === 1) return { mode: 'disabled' }
  if (value.mode === 'fixed') {
    const providerId = asString(value.providerId)
    const model = asString(value.model)
    const reasoningEffort = asString(value.reasoningEffort)
    if (
      Object.keys(value).length === 4 &&
      providerId &&
      model &&
      isReasoningEffort(reasoningEffort)
    ) {
      return { mode: 'fixed', providerId, model, reasoningEffort }
    }
  }
  return DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION
}

const sanitizeVisionModel = (value: unknown): VisionModelConfiguration | undefined => {
  if (!isRecord(value)) return undefined
  const providerId = asString(value.providerId)
  const model = asString(value.model)
  const reasoningEffort = asString(value.reasoningEffort)
  return providerId && model && isReasoningEffort(reasoningEffort)
    ? { providerId, model, reasoningEffort }
    : undefined
}

// Validates the per-language manual-interpreter catalog without applying platform-specific rules.
const sanitizeManualInterpreters = (
  value: unknown
): Partial<Record<NotebookLanguage, string[]>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, string[]>> = {}
  for (const language of ['python', 'r'] as const) {
    const paths = asStringArray(value[language])
    const cleaned = [...new Set(paths.map((path) => path.trim()).filter(Boolean))]
    if (cleaned.length > 0) result[language] = cleaned
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Validates one persisted RuntimeSelection and defaults explicit authority flags to false.
const sanitizeRuntimeSelection = (value: unknown): RuntimeSelection | undefined => {
  if (!isRecord(value)) return undefined
  if (value.source === 'managed') return { source: 'managed' }
  if (value.source !== 'external') return undefined
  const interpreterPath = asString(value.interpreterPath)
  if (!interpreterPath) return undefined
  const interpreterArgs = asStringArray(value.interpreterArgs)
  return {
    source: 'external',
    interpreterPath,
    ...(interpreterArgs.length > 0 ? { interpreterArgs } : {}),
    appOwnedOverlay: value.appOwnedOverlay === true,
    packageInstallAuthorized: value.packageInstallAuthorized === true
  }
}

// Keeps only known languages; R remains managed-only in the current persisted contract.
const sanitizeNotebookRuntimes = (
  value: unknown
): Partial<Record<NotebookLanguage, RuntimeSelection>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, RuntimeSelection>> = {}
  for (const language of ['python', 'r'] as const) {
    const selection = sanitizeRuntimeSelection(value[language])
    if (!selection || (language === 'r' && selection.source === 'external')) continue
    result[language] = selection
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const sanitizeRuntimeEnablementEntry = (value: unknown): RuntimeEnablement => ({
  enabled: asBooleanRecord(isRecord(value) ? value.enabled : undefined),
  installAuthorized: asBooleanRecord(isRecord(value) ? value.installAuthorized : undefined)
})

const sanitizeRuntimeEnablement = (
  value: unknown
): Partial<Record<NotebookLanguage, RuntimeEnablement>> | undefined => {
  if (!isRecord(value)) return undefined
  const result: Partial<Record<NotebookLanguage, RuntimeEnablement>> = {}
  for (const language of ['python', 'r'] as const) {
    const entry = sanitizeRuntimeEnablementEntry(value[language])
    if (Object.keys(entry.enabled).length || Object.keys(entry.installAuthorized).length) {
      result[language] = entry
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Rebuilds the whole settings document, applying migrations before cross-field selection cleanup.
const sanitizeSettings = (value: unknown): StoredSettings => {
  if (!isRecord(value)) return createEmptySettings()

  const sanitizedProviders = Array.isArray(value.providers)
    ? value.providers
        .map(sanitizeProvider)
        .filter((provider): provider is StoredProvider => !!provider)
    : []
  const legacyActiveProviderId = asString(value.activeProviderId)
  const codexProviders = sanitizedProviders.filter((provider) =>
    isCodexSubscriptionProvider(provider.type)
  )
  const selectedCodexProvider =
    codexProviders.find((provider) => provider.id === legacyActiveProviderId) ?? codexProviders[0]
  const migratedCodexProvider = selectedCodexProvider
    ? {
        ...selectedCodexProvider,
        id: CODEX_SUBSCRIPTION_PROVIDER_ID,
        type: 'codex-isolated' as const,
        codexAuthMode: selectedCodexProvider.codexAuthMode ?? 'isolated',
        name: codexSubscriptionProviderIdentity().name
      }
    : undefined

  // Legacy shared validation describes the global home, not the app-owned isolated profile.
  if (selectedCodexProvider?.type === 'codex-shared' && migratedCodexProvider) {
    delete migratedCodexProvider.lastValidatedAt
    delete migratedCodexProvider.lastValidationFailure
    delete migratedCodexProvider.expiresAt
  }

  const providers = [
    ...sanitizedProviders.filter((provider) => !isCodexSubscriptionProvider(provider.type)),
    ...(migratedCodexProvider ? [migratedCodexProvider] : [])
  ]
  const visionModel = sanitizeVisionModel(value.visionModel)
  const settings: StoredSettings = {
    version: SETTINGS_FILE_VERSION,
    providers,
    subagentModel: sanitizeSubagentModel(value.subagentModel),
    reviewerModel: sanitizeSubagentModel(value.reviewerModel),
    sessionDetailsModel: sanitizeSessionDetailsModel(value.sessionDetailsModel),
    ...(visionModel ? { visionModel } : {})
  }
  const claudeSubscriptionProviderId = asString(value.claudeSubscriptionProviderId)
  if (
    claudeSubscriptionProviderId &&
    isClaudeSubscriptionProviderId(claudeSubscriptionProviderId) &&
    providers.some(
      (provider) =>
        provider.id === claudeSubscriptionProviderId && isClaudeSubscriptionProvider(provider.type)
    )
  ) {
    settings.claudeSubscriptionProviderId = claudeSubscriptionProviderId
  }

  const claude = sanitizeClaudeInfo(value.claude)
  const codex = sanitizeCodexInfo(value.codex)
  const activeProviderId =
    legacyActiveProviderId && isCodexSubscriptionProviderId(legacyActiveProviderId)
      ? CODEX_SUBSCRIPTION_PROVIDER_ID
      : legacyActiveProviderId
  if (claude) settings.claude = claude
  if (codex) settings.codex = codex
  if (activeProviderId && providers.some((provider) => provider.id === activeProviderId)) {
    settings.activeProviderId = activeProviderId
    const activeProvider = providers.find((provider) => provider.id === activeProviderId)
    const activeModel = asString(value.activeModel) ?? activeProvider?.model
    if (activeModel) settings.activeModel = activeModel
  }

  const onboardingCompletedAt = asNumber(value.onboardingCompletedAt)
  if (onboardingCompletedAt !== undefined) settings.onboardingCompletedAt = onboardingCompletedAt

  const disabledSkillIds = Array.isArray(value.disabledSkillIds)
    ? [
        ...new Set(
          value.disabledSkillIds.filter(
            (entry): entry is string => typeof entry === 'string' && entry !== ''
          )
        )
      ]
    : []
  if (disabledSkillIds.length > 0) settings.disabledSkillIds = disabledSkillIds

  const githubTokenRef = asString(value.githubTokenRef)
  const githubTokenMask = asString(value.githubTokenMask)
  if (githubTokenRef) settings.githubTokenRef = githubTokenRef
  if (githubTokenMask) settings.githubTokenMask = githubTokenMask

  const connectors = sanitizeConnectors(value.connectors)
  if (connectors) settings.connectors = connectors
  const packageMirror = sanitizePackageMirror(value.packageMirror)
  if (packageMirror) settings.packageMirror = packageMirror
  const networkProxy = normalizeNetworkProxySettings(value.networkProxy)
  if (networkProxy && networkProxy.mode !== 'system') settings.networkProxy = networkProxy
  if (value.notebookNetwork !== undefined) {
    settings.notebookNetwork = normalizeNotebookNetworkSettings(value.notebookNetwork)
  }

  const pathsNormalizedAt = asNumber(value.pathsNormalizedAt)
  if (pathsNormalizedAt !== undefined) settings.pathsNormalizedAt = pathsNormalizedAt
  const legacyDataMovePromptDismissedAt = asNumber(value.legacyDataMovePromptDismissedAt)
  if (legacyDataMovePromptDismissedAt !== undefined) {
    settings.legacyDataMovePromptDismissedAt = legacyDataMovePromptDismissedAt
  }

  // Keep absolute paths canonical without stripping a filesystem root on any supported platform.
  const dataRoot = asString(value.dataRoot)?.trim()
  if (dataRoot && isAbsolute(dataRoot)) {
    const normalized = normalize(dataRoot)
    const { root } = parse(normalized)
    settings.dataRoot =
      normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
  }

  const agentFrameworkId = asString(value.agentFrameworkId)
  if (
    agentFrameworkId === 'claude-code' ||
    agentFrameworkId === 'opencode' ||
    agentFrameworkId === 'codex' ||
    agentFrameworkId === 'codebuddy'
  ) {
    settings.agentFrameworkId = agentFrameworkId
  }
  const reasoningEffort = asString(value.reasoningEffort)
  if (isReasoningEffort(reasoningEffort)) settings.reasoningEffort = reasoningEffort
  const notificationsEnabled = asBoolean(value.notificationsEnabled)
  if (notificationsEnabled !== undefined) settings.notificationsEnabled = notificationsEnabled
  const showNotificationContent = asBoolean(value.showNotificationContent)
  if (showNotificationContent !== undefined) {
    settings.showNotificationContent = showNotificationContent
  }
  const conversationSkillImportEnabled = asBoolean(value.conversationSkillImportEnabled)
  if (conversationSkillImportEnabled !== undefined) {
    settings.conversationSkillImportEnabled = conversationSkillImportEnabled
  }
  if (isLanguagePreference(value.localePreference)) {
    settings.localePreference = value.localePreference
  }
  const closePreference = asString(value.closePreference)
  if (closePreference === 'minimize' || closePreference === 'quit') {
    settings.closePreference = closePreference
  }
  // Files-tab source filter; only a well-shaped value survives so a hand-edited settings.json
  // cannot crash the restore path.
  const projectFilesFilter = sanitizeProjectFilesFilter(value.projectFilesFilter)
  if (projectFilesFilter !== undefined) settings.projectFilesFilter = projectFilesFilter
  if (isAppIconVariant(value.appIconVariant)) settings.appIconVariant = value.appIconVariant
  if (isPermissionProfileId(value.defaultPermissionProfile)) {
    settings.defaultPermissionProfile = value.defaultPermissionProfile
  }

  const opencodePath = asString(value.opencodePath)
  if (opencodePath) {
    settings.opencodePath = opencodePath
    const opencodeVersion = asString(value.opencodeVersion)
    if (opencodeVersion) settings.opencodeVersion = opencodeVersion
  }

  const codebuddyPath = asString(value.codebuddyPath)
  if (codebuddyPath) {
    settings.codebuddyPath = codebuddyPath
    const codebuddyVersion = asString(value.codebuddyVersion)
    if (codebuddyVersion) settings.codebuddyVersion = codebuddyVersion
  }

  const notebookRuntimes = sanitizeNotebookRuntimes(value.notebookRuntimes)
  if (notebookRuntimes) settings.notebookRuntimes = notebookRuntimes
  const notebookRuntimeEnablement = sanitizeRuntimeEnablement(value.notebookRuntimeEnablement)
  if (notebookRuntimeEnablement) settings.notebookRuntimeEnablement = notebookRuntimeEnablement
  const notebookManualInterpreters = sanitizeManualInterpreters(value.notebookManualInterpreters)
  if (notebookManualInterpreters) settings.notebookManualInterpreters = notebookManualInterpreters

  if (isRecord(value.computeBookmarks)) {
    const computeBookmarks: Record<string, string[]> = Object.fromEntries(
      Object.entries(value.computeBookmarks).flatMap(([providerId, folders]) =>
        Array.isArray(folders) ? [[providerId, asStringArray(folders)]] : []
      )
    )
    if (Object.keys(computeBookmarks).length > 0) settings.computeBookmarks = computeBookmarks
  }

  const computeGrants = Array.isArray(value.computeGrants)
    ? value.computeGrants
        .map(sanitizeComputeGrant)
        .filter((grant): grant is StoredComputeGrant => grant !== undefined)
    : undefined
  if (computeGrants?.length) settings.computeGrants = computeGrants

  // Legacy granted local roots ("Grant folder access"): well-formed entries are preserved so the
  // one-time import into the GrantedLocalRoot table can read them; corrupt entries are dropped.
  // Production never appends to this field — the import removes it once the rows land in the DB.
  const grantedLocalRoots = Array.isArray(value.grantedLocalRoots)
    ? value.grantedLocalRoots
        .map(sanitizeGrantedLocalRoot)
        .filter((root): root is GrantedLocalRoot => root !== undefined)
    : undefined
  if (grantedLocalRoots?.length) settings.grantedLocalRoots = grantedLocalRoots
  return settings
}

export { sanitizeSessionDetailsModel, sanitizeSettings, sanitizeSubagentModel }
