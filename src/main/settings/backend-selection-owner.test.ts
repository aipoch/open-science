import { describe, expect, it, vi } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { NO_ACTIVE_PROVIDER_MESSAGE } from '../../shared/run-error-classification'
import { BackendSelectionOwner } from './backend-selection-owner'
import type { StoredSettings } from './types'

const settings = (overrides: Partial<StoredSettings> = {}): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: [
    {
      id: 'provider-a',
      type: 'custom',
      name: 'Provider A',
      model: 'model-a',
      keyRef: 'enc:credential'
    }
  ],
  activeProviderId: 'provider-a',
  activeModel: 'model-a',
  agentFrameworkId: 'codex',
  reasoningEffort: 'high',
  ...overrides
})

describe('BackendSelectionOwner', () => {
  it('captures only the configured framework without credentials or runtime state', async () => {
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => settings()),
      readFrameworkOverride: vi.fn(() => undefined),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })

    const selection = await owner.captureConfiguredSelection()

    expect(selection).toEqual({ frameworkId: 'codex' })
    expect(Object.keys(selection)).toEqual(['frameworkId'])
    expect(JSON.stringify(selection)).not.toMatch(/credential|provider|model|reasoning|lease/i)
  })

  it('honors the CodeBuddy framework override', async () => {
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => settings()),
      readFrameworkOverride: vi.fn(() => 'codebuddy'),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })

    await expect(owner.captureConfiguredSelection()).resolves.toEqual({
      frameworkId: 'codebuddy'
    })
  })

  it('freezes the explicit provider, model, framework, and reasoning intent without secrets', async () => {
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => settings()),
      readFrameworkOverride: vi.fn(() => undefined),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })

    const target = await owner.captureExplicitTarget()

    expect(target).toEqual({
      frameworkId: 'codex',
      providerId: 'provider-a',
      model: { kind: 'required', id: 'model-a' },
      reasoningEffort: 'high'
    })
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target.model)).toBe(true)
    expect(JSON.stringify(target)).not.toMatch(/credential|key|connection|lease|orchestration/i)
  })

  it('late-binds configured provider/model/reasoning while keeping an explicit target fixed', async () => {
    let current = settings()
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => current),
      readFrameworkOverride: vi.fn(() => undefined),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })
    const configured = await owner.captureConfiguredSelection()
    const explicit = await owner.captureExplicitTarget()
    current = settings({
      providers: [
        ...current.providers,
        { id: 'provider-b', type: 'custom', name: 'Provider B', model: 'model-b' }
      ],
      activeProviderId: 'provider-b',
      activeModel: 'model-b-current',
      agentFrameworkId: 'claude-code',
      reasoningEffort: 'low'
    })

    await expect(owner.resolveSelection(configured)).resolves.toMatchObject({
      settings: current,
      frameworkId: 'codex',
      providerId: 'provider-b',
      modelSelection: { kind: 'configured', requestedModel: 'model-b-current' },
      reasoningEffort: 'low'
    })
    await expect(owner.resolveExplicitTarget(explicit)).resolves.toMatchObject({
      settings: current,
      frameworkId: 'codex',
      providerId: 'provider-a',
      modelSelection: { kind: 'required', model: 'model-a' },
      reasoningEffort: 'high'
    })
  })

  it('rejects a missing configured provider at selection resolution', async () => {
    let current = settings()
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => current),
      readFrameworkOverride: vi.fn(() => undefined),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })
    const selection = await owner.captureConfiguredSelection()
    current = settings({ providers: [], activeProviderId: undefined, activeModel: undefined })

    await expect(owner.resolveSelection(selection)).rejects.toThrow(NO_ACTIVE_PROVIDER_MESSAGE)
  })

  it('resolves the current model-change selection or returns undefined without a provider', async () => {
    let current = settings()
    const readFrameworkOverride = vi.fn(() => 'opencode')
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => current),
      readFrameworkOverride,
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })

    await expect(owner.resolveActiveModelChangeSelection()).resolves.toMatchObject({
      settings: current,
      frameworkId: 'opencode',
      providerId: 'provider-a',
      modelSelection: { kind: 'configured', requestedModel: 'model-a' },
      reasoningEffort: 'high'
    })

    current = settings({ providers: [], activeProviderId: undefined, activeModel: undefined })
    await expect(owner.resolveActiveModelChangeSelection()).resolves.toBeUndefined()
    expect(readFrameworkOverride).toHaveBeenCalledTimes(2)
  })

  it('resolves reasoning intent from the current provider without resolving a runtime target', async () => {
    const resolveRuntimeReasoningEffortProfile = vi.fn(() => ({
      supported: true as const,
      slots: ['low', 'medium', 'high', 'xhigh', 'max'] as const
    }))
    const owner = new BackendSelectionOwner({
      readSettings: vi.fn(async () => settings()),
      readFrameworkOverride: vi.fn(() => undefined),
      resolveRuntimeReasoningEffortProfile
    })

    await expect(owner.resolveActiveReasoningEffort('max')).resolves.toBe('max')
    expect(resolveRuntimeReasoningEffortProfile).toHaveBeenCalledWith(
      settings().providers[0],
      'model-a'
    )
  })

  it('resolves the active configured selection from one settings snapshot', async () => {
    const readSettings = vi.fn(async () => settings())
    const owner = new BackendSelectionOwner({
      readSettings,
      readFrameworkOverride: vi.fn(() => 'claude-code'),
      resolveRuntimeReasoningEffortProfile: vi.fn()
    })

    await expect(owner.resolveActiveSelection()).resolves.toMatchObject({
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      modelSelection: { kind: 'configured', requestedModel: 'model-a' },
      reasoningEffort: 'high'
    })
    expect(readSettings).toHaveBeenCalledOnce()
  })
})
