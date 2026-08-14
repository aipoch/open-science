import { describe, expect, it, vi } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import { claudeCodeFramework, type ResolvedAgentBackend } from '../agent-framework'
import type { AgentBackendResolver } from './backend-resolver'
import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'
import { SubagentModelOwner } from './subagent-model-owner'
import type { StoredSettings } from './types'

const backend = (): ResolvedAgentBackend => ({
  framework: claudeCodeFramework,
  backendId: 'claude-code:provider-a',
  modelRoute: 'claude-anthropic',
  executablePath: '/runtime/claude',
  env: {},
  contextUsageModel: 'model-a'
})

const owner = (
  settings: StoredSettings,
  resolver: Pick<AgentBackendResolver, 'resolveExplicitTarget' | 'resolveAdmittedTarget'>
): SubagentModelOwner =>
  new SubagentModelOwner({
    repository: { getSettings: vi.fn(async () => settings) } as unknown as SettingsRepository,
    providers: {} as ProviderAccountsModule,
    backendResolver: resolver as AgentBackendResolver
  })

describe('SubagentModelOwner Skill runtime scope', () => {
  it('resolves a configured Subagent admission with a Subagent runtime scope', async () => {
    const resolveExplicitTarget = vi.fn(async () => backend())
    const settings: StoredSettings = {
      version: SETTINGS_FILE_VERSION,
      providers: [],
      subagentModel: {
        mode: 'fixed',
        providerId: 'provider-a',
        model: 'model-a',
        reasoningEffort: 'medium'
      }
    }

    const admission = await owner(settings, {
      resolveExplicitTarget,
      resolveAdmittedTarget: vi.fn()
    }).admit('claude-code', {})

    expect(resolveExplicitTarget).toHaveBeenCalledWith(
      expect.objectContaining({ frameworkId: 'claude-code', providerId: 'provider-a' }),
      { skillRuntime: { scope: { kind: 'subagent' } } }
    )
    await admission.backendLease?.release()
  })

  it('resolves an inherited admitted backend with a Subagent runtime scope', async () => {
    const resolveAdmittedTarget = vi.fn(async () => backend())
    const settings: StoredSettings = {
      version: SETTINGS_FILE_VERSION,
      providers: [],
      subagentModel: { mode: 'inherit' }
    }

    const admission = await owner(settings, {
      resolveExplicitTarget: vi.fn(),
      resolveAdmittedTarget
    }).admit('claude-code', {
      backendId: 'claude-code:provider-a',
      modelRoute: 'claude-anthropic',
      model: 'model-a'
    })

    expect(resolveAdmittedTarget).toHaveBeenCalledWith(
      expect.objectContaining({ frameworkId: 'claude-code', providerId: 'provider-a' }),
      { skillRuntime: { scope: { kind: 'subagent' } } }
    )
    await admission.backendLease?.release()
  })
})
