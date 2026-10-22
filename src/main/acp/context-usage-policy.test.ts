import { describe, expect, it, vi } from 'vitest'

import { getAgentFramework, opencodeFramework } from '../agent-framework'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import { AcpContextUsagePolicy } from './context-usage-policy'
import { ContextUsageTracker } from './context-usage-tracker'

const backend = (overrides: Partial<AcpBackendGenerationView> = {}): AcpBackendGenerationView => ({
  framework: opencodeFramework,
  session: { model: 'requested/model', modelRequired: false },
  prompt: { systemPromptAppends: [] },
  context: { model: 'tokenizer/model', window: 128_000, supportsImageInput: false },
  adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false },
  ...overrides
})

describe('AcpContextUsagePolicy', () => {
  it.each(['codex-responses', 'codex-responses-compatibility', 'codex-bridge'] as const)(
    'retains the native effective window through usage and preflight for %s',
    (modelRoute) => {
      const policy = new AcpContextUsagePolicy({
        backend: () =>
          backend({
            framework: getAgentFramework('codex'),
            modelRoute,
            context: { model: 'gpt-6-astra', window: 1_050_000, supportsImageInput: true }
          }),
        appliedModel: () => 'gpt-6-astra',
        systemPromptAppends: () => [],
        tooling: () => ({ artifacts: false, notebook: false, skillImport: false })
      })
      const tracker = new ContextUsageTracker()
      const resolved = policy.resolve('session-1')
      tracker.beginSession('session-1', resolved.estimateInput)
      tracker.refreshUsage('session-1', 'preflight', resolved.selectedWindow)
      expect(tracker.usage('session-1')?.size).toBeUndefined()

      // Native metadata can change with a catalog refresh; never substitute the API total.
      for (const size of [828_400, 997_500]) {
        tracker.reconcileProviderUsage(
          'session-1',
          { used: 300_000, size },
          resolved.selectedWindow
        )
        expect(tracker.usage('session-1')?.size).toBe(size)
        tracker.refreshUsage(
          'session-1',
          'preflight',
          resolved.selectedWindow ?? tracker.usage('session-1')?.size
        )
        expect(tracker.usage('session-1')?.size).toBe(size)
      }
    }
  )

  it.each(['claude-code', 'opencode'] as const)(
    'preserves the selected provider window for %s',
    (frameworkId) => {
      const policy = new AcpContextUsagePolicy({
        backend: () => backend({ framework: getAgentFramework(frameworkId) }),
        appliedModel: () => 'confirmed/model',
        systemPromptAppends: () => [],
        tooling: () => ({ artifacts: false, notebook: false, skillImport: false })
      })
      expect(policy.resolve('session-1').selectedWindow).toBe(128_000)
    }
  )

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
