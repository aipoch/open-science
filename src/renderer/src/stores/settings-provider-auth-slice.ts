import type { StoreApi } from 'zustand'

import {
  claudeIsolatedProviderIdentity,
  claudeSharedProviderIdentity,
  codexSubscriptionProviderIdentity,
  xaiSubscriptionProviderIdentity,
  isCodexSubscriptionProvider
} from '../../../shared/settings'
import type {
  AgentFrameworkId,
  ProviderView,
  RefreshProviderModelsResult,
  SettingsSnapshot,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult,
  XaiOAuthDeviceAuthorization
} from '../../../shared/settings'
import type { SettingsWriteCoordinator } from './settings-write-coordinator'

export type SaveProviderResult = {
  providerId: string
  validation: ValidateProviderResult
}

export type ProviderAuthActions = {
  persistProvider: (request: UpsertProviderRequest) => Promise<string>
  saveProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  saveAndActivateProvider: (request: UpsertProviderRequest) => Promise<SaveProviderResult>
  validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  cancelCodexLogin: () => Promise<void>
  loginIsolatedCodex: () => Promise<ValidateProviderResult>
  logoutIsolatedCodex: () => Promise<ValidateProviderResult>
  loginSharedClaude: () => Promise<ValidateProviderResult>
  cancelSharedClaudeLogin: () => Promise<void>
  logoutSharedClaude: () => Promise<ValidateProviderResult>
  loginIsolatedClaude: (token: string) => Promise<ValidateProviderResult>
  loginIsolatedClaudeBrowser: () => Promise<ValidateProviderResult>
  cancelIsolatedClaudeLogin: () => Promise<void>
  logoutIsolatedClaude: () => Promise<ValidateProviderResult>
  beginXaiOAuthLogin: () => Promise<XaiOAuthDeviceAuthorization>
  waitXaiOAuthLogin: () => Promise<{ accountEmail?: string }>
  cancelXaiOAuthLogin: () => Promise<void>
  logoutXaiOAuth: () => Promise<void>
  refreshProviderModels: (providerId: string) => Promise<RefreshProviderModelsResult>
  setActiveProvider: (providerId: string, model?: string) => Promise<void>
  setAgentFramework: (id: AgentFrameworkId) => Promise<void>
  deleteProvider: (providerId: string) => Promise<void>
}

// This slice owns workflows only. Core remains the sole owner of the full Settings snapshot so
// provider/runtime/preferences fields continue to reconcile in one atomic store update.

type ProviderAuthHost = ProviderAuthActions & { providers: ProviderView[] }

type ProviderAuthCommands = Pick<
  Window['api']['settings'],
  | 'getSettings'
  | 'upsertProvider'
  | 'deleteProvider'
  | 'setActiveProvider'
  | 'setAgentFramework'
  | 'validateProvider'
  | 'cancelCodexLogin'
  | 'cancelClaudeLogin'
  | 'loginIsolatedCodex'
  | 'logoutIsolatedCodex'
  | 'loginSharedClaude'
  | 'logoutSharedClaude'
  | 'loginIsolatedClaude'
  | 'loginIsolatedClaudeBrowser'
  | 'cancelIsolatedClaudeLogin'
  | 'logoutIsolatedClaude'
  | 'refreshProviderModels'
  | 'beginXaiOAuthLogin'
  | 'waitXaiOAuthLogin'
  | 'cancelXaiOAuthLogin'
  | 'logoutXaiOAuth'
>

type ProviderAuthSliceOptions<Store extends ProviderAuthHost> = {
  get: StoreApi<Store>['getState']
  getCommands: () => ProviderAuthCommands
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void
  refreshPreflight: () => Promise<unknown>
  refreshFrameworkStatus: (id: AgentFrameworkId) => Promise<void>
  writeCoordinator: SettingsWriteCoordinator
}

const resolveUpsertedProviderId = (
  request: UpsertProviderRequest,
  before: ProviderView[],
  after: ProviderView[]
): string | undefined => {
  if (isCodexSubscriptionProvider(request.type)) {
    return codexSubscriptionProviderIdentity().id
  }
  if (request.type === 'claude-shared') return claudeSharedProviderIdentity().id
  if (request.type === 'claude-isolated') return claudeIsolatedProviderIdentity().id
  if (request.type === 'xai-subscription') return xaiSubscriptionProviderIdentity().id
  if (request.id) return request.id

  const beforeIds = new Set(before.map((provider) => provider.id))
  return after.find((provider) => !beforeIds.has(provider.id))?.id
}

export const createProviderAuthSlice = <Store extends ProviderAuthHost>({
  get,
  getCommands,
  reconcileSnapshot,
  refreshPreflight,
  refreshFrameworkStatus,
  writeCoordinator
}: ProviderAuthSliceOptions<Store>): ProviderAuthActions => ({
  persistProvider: async (request) => {
    const commands = getCommands()
    const before = get().providers
    const snapshot = await commands.upsertProvider(request)

    reconcileSnapshot(snapshot)
    await refreshPreflight()
    return resolveUpsertedProviderId(request, before, snapshot.providers) ?? ''
  },

  saveProvider: async (request) => {
    const commands = getCommands()
    const before = get().providers
    const snapshot = await commands.upsertProvider(request)
    reconcileSnapshot(snapshot)

    const providerId = resolveUpsertedProviderId(request, before, snapshot.providers)
    if (!providerId) {
      return { providerId: '', validation: { ok: false, category: 'unknown' } }
    }

    const validation = await commands.validateProvider({ providerId })
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return { providerId, validation }
  },

  saveAndActivateProvider: async (request) => {
    const result = await get().saveProvider(request)
    if (result.providerId) await get().setActiveProvider(result.providerId, request.model)
    return result
  },

  validateProvider: async (request) => {
    const commands = getCommands()
    const result = await commands.validateProvider(request)
    if (request.providerId) {
      reconcileSnapshot(await commands.getSettings())
      await refreshPreflight()
    }
    return result
  },

  cancelCodexLogin: () => getCommands().cancelCodexLogin(),

  loginIsolatedCodex: async () => {
    const commands = getCommands()
    const result = await commands.loginIsolatedCodex()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  logoutIsolatedCodex: async () => {
    const commands = getCommands()
    const result = await commands.logoutIsolatedCodex()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  loginSharedClaude: async () => {
    const commands = getCommands()
    const result = await commands.loginSharedClaude()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  cancelSharedClaudeLogin: async () => {
    await getCommands().cancelClaudeLogin()
  },

  logoutSharedClaude: async () => {
    const commands = getCommands()
    const result = await commands.logoutSharedClaude()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  loginIsolatedClaude: async (token) => {
    const commands = getCommands()
    const result = await commands.loginIsolatedClaude(token)
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  loginIsolatedClaudeBrowser: async () => {
    const commands = getCommands()
    const result = await commands.loginIsolatedClaudeBrowser()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  cancelIsolatedClaudeLogin: async () => {
    await getCommands().cancelIsolatedClaudeLogin()
  },

  logoutIsolatedClaude: async () => {
    const commands = getCommands()
    const result = await commands.logoutIsolatedClaude()
    reconcileSnapshot(await commands.getSettings())
    await refreshPreflight()
    return result
  },

  beginXaiOAuthLogin: () => getCommands().beginXaiOAuthLogin(),

  waitXaiOAuthLogin: async () => {
    const result = await getCommands().waitXaiOAuthLogin()
    reconcileSnapshot(await getCommands().getSettings())
    await refreshPreflight()
    return result
  },

  cancelXaiOAuthLogin: () => getCommands().cancelXaiOAuthLogin(),

  logoutXaiOAuth: async () => {
    const snapshot = await getCommands().logoutXaiOAuth()
    reconcileSnapshot(snapshot)
    await refreshPreflight()
  },

  refreshProviderModels: async (providerId) => {
    const commands = getCommands()
    const result = await commands.refreshProviderModels({ providerId })
    if (result.ok) reconcileSnapshot(await commands.getSettings())
    return result
  },

  setActiveProvider: async (providerId, model) => {
    const write = writeCoordinator.begin('activeProvider')
    let snapshot: SettingsSnapshot
    try {
      snapshot = await getCommands().setActiveProvider({
        id: providerId,
        model: model || undefined
      })
    } catch (error) {
      write.fail('Could not switch active provider or model. Try again.')
      console.error('Failed to set active provider', error)
      throw error
    }

    if (!write.isCurrent()) return
    reconcileSnapshot(snapshot)
    write.succeed()
    await refreshPreflight()
  },

  setAgentFramework: async (id) => {
    const write = writeCoordinator.begin('agentFramework')
    let snapshot: SettingsSnapshot
    try {
      snapshot = await getCommands().setAgentFramework({ id })
    } catch (error) {
      write.fail('Could not switch agent framework. Try again.')
      console.error('Failed to switch agent framework', error)
      throw error
    }

    if (!write.isCurrent()) return
    reconcileSnapshot(snapshot)
    write.succeed()

    try {
      await refreshFrameworkStatus(id)
    } catch (error) {
      console.error('Failed to refresh agent framework status', error)
    }
  },

  deleteProvider: async (providerId) => {
    const snapshot = await getCommands().deleteProvider({ id: providerId })
    reconcileSnapshot(snapshot)
    await refreshPreflight()
  }
})
