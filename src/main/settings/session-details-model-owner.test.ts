import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  CODEX_SHARED_PROVIDER_ID,
  type SessionDetailsModelConfiguration
} from '../../shared/settings'
import { SessionDetailsModelOwner } from './session-details-model-owner'
import type { SettingsRepository } from './repository'
import type { ProviderAccountsModule } from './provider-accounts'
import type { AgentBackendResolver } from './backend-resolver'
import type { StoredProvider, StoredSettings } from './types'

const provider: StoredProvider = {
  id: 'provider-a',
  type: 'custom' as const,
  name: 'Provider A',
  model: 'model-a',
  keyRef: 'encrypted'
}

const createOwner = (
  configuration: SessionDetailsModelConfiguration,
  providerPatch: Partial<StoredProvider> = {}
): {
  owner: SessionDetailsModelOwner
  repository: SettingsRepository
  providers: ProviderAccountsModule
} => {
  let settings = {
    version: 2,
    providers: [{ ...provider, ...providerPatch }],
    agentFrameworkId: 'opencode' as const,
    sessionDetailsModel: configuration
  } satisfies StoredSettings
  const repository = {
    getSettings: vi.fn(async () => settings),
    setSessionDetailsModel: vi.fn(async (candidate, validate) => {
      const validated = validate?.(settings, candidate) ?? candidate
      settings = { ...settings, sessionDetailsModel: validated }
      return settings
    })
  } as unknown as SettingsRepository
  const providers = {
    resolveRuntimeTarget: vi.fn((_provider, selection) => ({
      providerId: provider.id,
      providerType: provider.type,
      effectiveModel: selection.kind === 'required' ? selection.model : provider.model,
      apiEndpoints: ['chat-completions'],
      frameworkCompatible: true,
      modelBridgeSupported: true,
      needsChatResponsesToChatCompletionsBridge: false,
      reasoningEffortProfile: { supported: false }
    }))
  } as unknown as ProviderAccountsModule
  const backendResolver = {
    captureConfiguredSelection: vi.fn(async () => ({ frameworkId: 'opencode' as const }))
  } as unknown as AgentBackendResolver
  return {
    owner: new SessionDetailsModelOwner({ repository, providers, backendResolver }),
    repository,
    providers
  }
}

const session = (patch: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-a',
    projectId: 'project-a',
    title: 'Title',
    cwd: '/workspace',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }) as PersistedChatSession

describe('SessionDetailsModelOwner', () => {
  it.each(['codex-isolated', 'codex-shared'] as const)(
    'admits the inherited %s subscription target',
    async (type) => {
      const providerId =
        type === 'codex-shared' ? CODEX_SHARED_PROVIDER_ID : CODEX_SUBSCRIPTION_PROVIDER_ID
      const { owner, providers } = createOwner(
        { mode: 'inherit', reasoningEffort: 'high' },
        { id: providerId, type }
      )
      await expect(
        owner.admit(
          session({
            agentFrameworkId: 'codex',
            agentModel: 'model-a',
            agentConfiguration: { providerId, model: 'model-a', reasoningEffort: 'high' }
          })
        )
      ).resolves.toEqual({
        mode: 'target',
        target: {
          frameworkId: 'codex',
          providerId,
          model: { kind: 'required', id: 'model-a' },
          reasoningEffort: 'high'
        }
      })
      expect(providers.resolveRuntimeTarget).not.toHaveBeenCalled()
    }
  )

  it('admits disabled without requiring a Session model target', async () => {
    const { owner } = createOwner({ mode: 'disabled' })
    await expect(owner.admit(session())).resolves.toEqual({ mode: 'disabled' })
  })

  it.each(['claude-code', 'opencode'] as const)(
    'rejects subscription inheritance through %s',
    async (frameworkId) => {
      const { owner } = createOwner(
        { mode: 'inherit', reasoningEffort: 'high' },
        { id: CODEX_SUBSCRIPTION_PROVIDER_ID, type: 'codex-isolated' }
      )
      await expect(
        owner.admit(
          session({
            agentFrameworkId: frameworkId,
            agentModel: 'model-a',
            agentConfiguration: {
              providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
              reasoningEffort: 'high'
            }
          })
        )
      ).rejects.toThrow('Codex subscription models cannot run')
    }
  )

  it('keeps subscription models unavailable as a fixed selection', async () => {
    const configuration = {
      mode: 'fixed',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      model: 'model-a',
      reasoningEffort: 'high'
    } as const
    const { owner } = createOwner(configuration, {
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      type: 'codex-isolated'
    })
    await expect(owner.set(configuration)).rejects.toThrow('Codex subscription models cannot run')
    await expect(owner.admit(session())).rejects.toThrow('Codex subscription models cannot run')
  })

  it('rejects an inherited subscription whose provider validation failed', async () => {
    const { owner } = createOwner(
      { mode: 'inherit', reasoningEffort: 'high' },
      {
        id: CODEX_SUBSCRIPTION_PROVIDER_ID,
        type: 'codex-isolated',
        lastValidationFailure: { at: 1, category: 'auth' }
      }
    )
    await expect(
      owner.admit(
        session({
          agentFrameworkId: 'codex',
          agentModel: 'model-a',
          agentConfiguration: {
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            reasoningEffort: 'high'
          }
        })
      )
    ).rejects.toThrow('provider is unavailable')
  })

  it('captures the durable Session target with the independent inherited effort', async () => {
    const { owner } = createOwner({ mode: 'inherit', reasoningEffort: 'low' })
    const admission = await owner.admit(
      session({
        agentFrameworkId: 'opencode',
        agentBackendId: 'opencode:provider-a',
        agentModel: 'saved-model',
        agentConfiguration: {
          providerId: 'provider-a',
          model: 'configured-model',
          reasoningEffort: 'high'
        }
      })
    )

    expect(admission).toEqual({
      mode: 'target',
      target: {
        frameworkId: 'opencode',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'saved-model' },
        reasoningEffort: 'low'
      }
    })
    expect(Object.isFrozen(admission)).toBe(true)
    expect(admission.mode === 'target' && Object.isFrozen(admission.target)).toBe(true)
  })

  it('admits a fixed configured target and preserves effort intent when unsupported', async () => {
    const { owner } = createOwner({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low'
    })

    await expect(owner.admit(session())).resolves.toEqual({
      mode: 'target',
      target: {
        frameworkId: 'opencode',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'model-a' },
        reasoningEffort: 'low'
      }
    })
    await owner.set({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low'
    })
    expect(await owner.getConfiguration()).toEqual({
      mode: 'fixed',
      providerId: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low'
    })
  })

  it('rejects an incomplete inherited Session target', async () => {
    const { owner } = createOwner({ mode: 'inherit', reasoningEffort: 'low' })
    await expect(owner.admit(session({ agentFrameworkId: 'opencode' }))).rejects.toThrow(
      'no complete Main model target'
    )
  })

  it('applies a targeted validation failure only to its matching model', async () => {
    const failure = {
      at: 20,
      category: 'model-not-found' as const,
      target: { model: 'model-b', endpoint: 'chat-completions' as const }
    }
    const { owner } = createOwner(
      {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'low'
      },
      { lastValidationFailure: failure }
    )

    await expect(
      owner.set({
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'low'
      })
    ).resolves.toBeUndefined()
    await expect(
      owner.set({
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-b',
        reasoningEffort: 'low'
      })
    ).rejects.toThrow('no longer available')
  })
})
