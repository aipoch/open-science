import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpContextUsagePolicy } from './context-usage-policy'

const backend = (overrides: Partial<AcpBackendGenerationView> = {}): AcpBackendGenerationView => ({
  framework: opencodeFramework,
  session: { model: 'requested/model', modelRequired: false },
  prompt: { systemPromptAppends: [] },
  context: { model: 'tokenizer/model', window: 128_000, supportsImageInput: false },
  adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false },
  ...overrides
})

describe('AcpContextUsagePolicy', () => {
  it('keeps Skill Runtime setup aligned with the published generation', () => {
    const buildSessionSetup = vi.fn(() => ({}))
    const skillRuntime = {
      projectionRoot: '/runtime/projection',
      discoveryRoot: '/runtime/projection/skills',
      descriptors: [],
      environment: {}
    }
    const policy = new AcpContextUsagePolicy({
      backend: () =>
        backend({
          framework: { ...opencodeFramework, buildSessionSetup },
          skillRuntime
        }),
      appliedModel: () => 'confirmed/model',
      systemPromptAppends: () => [],
      tooling: () => ({ artifacts: false, notebook: false, skillImport: false })
    })

    policy.resolve('session-1')

    expect(buildSessionSetup).toHaveBeenCalledWith(expect.objectContaining({ skillRuntime }))
  })

  it('rejects an OpenCode model and window until the Session confirms its applied model', () => {
    const selection: { appliedModel?: string } = {}
    const currentBackend = vi.fn(() => backend())
    const policy = new AcpContextUsagePolicy({
      backend: currentBackend,
      appliedModel: () => selection.appliedModel,
      systemPromptAppends: () => ['app guidance'],
      tooling: () => ({ artifacts: false, notebook: false, skillImport: false })
    })

    expect(policy.resolve('session-1')).toEqual({
      estimateInput: { frameworkId: 'opencode' }
    })

    selection.appliedModel = 'confirmed/model'
    expect(policy.resolve('session-1')).toMatchObject({
      estimateInput: { frameworkId: 'opencode', model: 'tokenizer/model' },
      selectedWindow: 128_000
    })
    expect(currentBackend).toHaveBeenCalledTimes(2)
  })

  it('preserves persistent prompt and enabled MCP sections in one generation decision', () => {
    const policy = new AcpContextUsagePolicy({
      backend: () =>
        backend({
          session: { modelRequired: false },
          prompt: {
            systemPromptAppends: [],
            persistentSystemPrompt: 'provider instructions'
          },
          context: { window: 200_000, supportsImageInput: false }
        }),
      appliedModel: () => 'confirmed/model',
      systemPromptAppends: () => ['must not replace provider prompt'],
      tooling: () => ({ artifacts: true, notebook: false, skillImport: false })
    })

    const resolved = policy.resolve('session-1')

    expect(resolved.estimateInput.persistentSystemPrompt).toEqual(['provider instructions'])
    expect(resolved.estimateInput.persistentSections?.map(({ sectionId }) => sectionId)).toEqual([
      'mcp-schema:open-science-artifacts'
    ])
    expect(resolved.selectedWindow).toBe(200_000)
  })
})
