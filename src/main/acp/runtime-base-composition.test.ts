import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'

const projectRoot = resolve(__dirname, '../../..')

describe('ACP Runtime base composition', () => {
  it('builds a fresh closed owner graph and preserves injected shared dependencies', () => {
    const contextUsageTracker = new ContextUsageTracker()
    const setTimer = vi.fn(() => 1 as never)
    const clearTimer = vi.fn()
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace/..//workspace',
      contextUsageTracker,
      setTimer,
      clearTimer
    }

    const first = composeAcpRuntimeBaseOwners(options)
    const second = composeAcpRuntimeBaseOwners(options)

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.snapshotOwner.cwd).toBe(resolve(options.defaultCwd))
    expect(first.contextUsageTracker).toBe(contextUsageTracker)
    expect(first.setTimer).toBe(setTimer)
    expect(first.clearTimer).toBe(clearTimer)
    expect(first.artifactTurns).toBeUndefined()
    expect(first.planService).toBeUndefined()
    expect(first.snapshotOwner).not.toBe(second.snapshotOwner)
    expect(first.connectionResources).not.toBe(second.connectionResources)
    expect(first.generationActivity).not.toBe(second.generationActivity)
    expect(first.connectionTransitions).not.toBe(second.connectionTransitions)
  })

  it('binds the generation and connection effects once before the graph is used', async () => {
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: '/workspace'
    })
    const hasActiveSessions = vi.fn(() => false)
    const activityChanged = vi.fn()
    const disconnect = vi.fn(async () => ({}) as never)
    const recoverFailedDeferredDisconnect = vi.fn()
    const publishIdle = vi.fn()

    expect(() => owners.generationActivity.blockers()).toThrow(
      'ACP generation/connection effects are not bound.'
    )

    owners.bindGenerationConnectionEffects({
      reviewerSessions: { hasActiveSessions },
      modelChanges: { activityChanged },
      connectionClose: { disconnect, recoverFailedDeferredDisconnect },
      publishIdle
    })

    expect(owners.generationActivity.blockers()).toEqual({
      reconnect: false,
      retirement: false
    })
    await owners.generationActivity.withActivity(async () => undefined)
    expect(activityChanged).toHaveBeenCalledOnce()

    await owners.connectionTransitions.requestProviderReconnect()
    expect(disconnect).toHaveBeenCalledWith(false)
    expect(publishIdle).toHaveBeenCalledOnce()
    expect(() =>
      owners.bindGenerationConnectionEffects({
        reviewerSessions: { hasActiveSessions },
        modelChanges: { activityChanged },
        connectionClose: { disconnect, recoverFailedDeferredDisconnect },
        publishIdle
      })
    ).toThrow('ACP generation/connection effects are already bound.')
  })

  it('keeps the canonical composer outside Runtime and Electron dependencies outside the composer', () => {
    const runtime = readFileSync(resolve(projectRoot, 'src/main/acp/runtime.ts'), 'utf8')
    const composer = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-base-composition.ts'),
      'utf8'
    )
    const applicationComposition = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-composition.ts'),
      'utf8'
    )

    expect(runtime).not.toMatch(
      /new (?:AcpRuntimeSnapshotOwner|AcpConnectionResourceOwner|AcpBackendGenerationOwner|ContextUsageTracker|AcpSessionInteractionOwner|AcpSessionCapabilityOwner|AcpGenerationActivityOwner|AcpConnectionTransitionOwner|AcpTurnSkillOwner|AcpSessionConfigurator|ArtifactTurnOwner|SessionPlanInteractionOwner|AcpPromptContentOwner|AcpSessionPresentationPolicy|AcpPromptOutcomeFinalizer)/
    )
    expect(composer).not.toMatch(/from ['"]electron['"]|import \{ AcpRuntime \}/)
    expect(composer).toContain("import type { AcpRuntimeOptions } from './runtime'")
    expect(applicationComposition).toContain('composeAcpRuntimeBaseOwners(runtimeOptions)')
    expect(applicationComposition).toContain(
      'composeAcpRuntimeSessionOwners(runtimeOptions, baseOwners)'
    )
    expect(runtime + applicationComposition).not.toContain('runtime.test-utils')
  })
})
