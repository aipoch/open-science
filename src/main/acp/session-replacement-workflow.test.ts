import type { ActiveSession, ClientConnection } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AcpCreateSessionResponse } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { AcpSessionRegistry } from './session-registry'
import { AcpSessionReplacementWorkflow } from './session-replacement-workflow'

const attachedSession = (sessionId: string, dispose = vi.fn()): ActiveSession =>
  ({ sessionId, dispose }) as unknown as ActiveSession

const publishSession = (
  registry: AcpSessionRegistry,
  appSessionId: string,
  providerSession: ActiveSession,
  frameworkId: AgentFrameworkId = 'claude-code'
): void => {
  const reserved = registry.reserve({ sessionIds: [appSessionId, providerSession.sessionId] })
  if (reserved.collision) throw reserved.collision
  registry.publish(reserved.reservation, appSessionId, {
    session: providerSession,
    cwd: '/old-workspace',
    projectId: 'old-project',
    frameworkId,
    permissionProfile: {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      availableModeIds: ['default'],
      fullAccessAvailable: false
    }
  })
  reserved.reservation.release()
}

describe('AcpSessionReplacementWorkflow', () => {
  it('replaces provider history under the stable App Session id through existing owners', async () => {
    const registry = new AcpSessionRegistry()
    const dispose = vi.fn()
    publishSession(registry, 'app-session', attachedSession('provider-session', dispose))
    const connection = {} as ClientConnection
    const replacement: AcpCreateSessionResponse = {
      sessionId: 'app-session',
      cwd: '/new-workspace',
      frameworkId: 'claude-code',
      contextReset: true
    }
    const cancelPermissionFlow = vi.fn()
    const clearLivePermissionProfile = vi.fn()
    const clearUserChoiceProvenanceForSession = vi.fn()
    const resetPromptContent = vi.fn()
    const releasePromptResourcesForSession = vi.fn()
    const resetContextUsage = vi.fn()
    const supersedeInteraction = vi.fn()
    const adopt = vi.fn(async () => replacement)
    const workflow = new AcpSessionReplacementWorkflow({
      defaultCwd: '/default-workspace',
      defaultProjectId: 'default-project',
      currentCwd: () => '/current-workspace',
      currentFrameworkId: () => 'claude-code',
      ensureConnected: vi.fn(async () => connection),
      assertCurrentConnection: vi.fn(),
      registry,
      reserveIdentity: (sessionId, publishedAppSessionId) =>
        registry.reserve({ sessionIds: [sessionId], publishedAppSessionId }),
      adopter: { adopt },
      permission: { cancelForSession: cancelPermissionFlow, clearLivePermissionProfile },
      elicitation: { cancelForSession: vi.fn() },
      clearUserChoiceProvenanceForSession,
      appContinuations: { delete: vi.fn() },
      promptContent: { resetSession: resetPromptContent },
      releasePromptResourcesForSession,
      contextUsage: { deleteSession: resetContextUsage },
      interactions: { current: vi.fn(), supersedeCurrent: supersedeInteraction }
    })

    await expect(
      workflow.reset({
        sessionId: 'app-session',
        cwd: '/new-workspace',
        projectId: 'new-project',
        permissionProfile: 'ask',
        memoryEnabled: false
      })
    ).resolves.toEqual(replacement)

    expect(dispose).toHaveBeenCalledOnce()
    expect(registry.lookup('app-session')?.attachment).toBeUndefined()
    expect(cancelPermissionFlow).toHaveBeenCalledWith('app-session')
    expect(clearUserChoiceProvenanceForSession).toHaveBeenCalledWith('app-session')
    expect(clearLivePermissionProfile).toHaveBeenCalledWith('app-session')
    expect(resetPromptContent).toHaveBeenCalledWith('app-session')
    expect(releasePromptResourcesForSession).toHaveBeenCalledWith('app-session')
    expect(resetContextUsage).toHaveBeenCalledWith('app-session')
    expect(supersedeInteraction).toHaveBeenCalledWith('app-session')
    expect(registry.lookup('app-session')?.aggregate.snapshot().memoryEnabled).toBe(false)
    expect(adopt).toHaveBeenCalledWith('app-session', {
      connection,
      cwd: resolve('/new-workspace'),
      projectId: 'new-project',
      identity: expect.any(Object),
      permissionProfile: 'ask',
      specialistId: undefined,
      memoryEnabled: false
    })
  })

  it('retains the stable identity reservation until asynchronous adoption completes', async () => {
    const registry = new AcpSessionRegistry()
    const connection = {} as ClientConnection
    let continueAdoption!: () => void
    const adoptionGate = new Promise<void>((resolve) => {
      continueAdoption = resolve
    })
    const adopt = vi.fn(async (_sessionId, request) => {
      await adoptionGate
      request.identity.assertCurrent()
      return {
        sessionId: 'app-session',
        cwd: '/workspace',
        frameworkId: 'claude-code' as const,
        contextReset: true as const
      }
    })
    const workflow = new AcpSessionReplacementWorkflow({
      defaultCwd: '/workspace',
      defaultProjectId: 'project',
      currentCwd: vi.fn(),
      currentFrameworkId: () => 'claude-code',
      ensureConnected: vi.fn(async () => connection),
      assertCurrentConnection: vi.fn(),
      registry,
      reserveIdentity: (sessionId, publishedAppSessionId) =>
        registry.reserve({ sessionIds: [sessionId], publishedAppSessionId }),
      adopter: { adopt },
      permission: { cancelForSession: vi.fn(), clearLivePermissionProfile: vi.fn() },
      elicitation: { cancelForSession: vi.fn() },
      clearUserChoiceProvenanceForSession: vi.fn(),
      appContinuations: { delete: vi.fn() },
      promptContent: { resetSession: vi.fn() },
      releasePromptResourcesForSession: vi.fn(),
      contextUsage: { deleteSession: vi.fn() },
      interactions: { current: vi.fn(), supersedeCurrent: vi.fn() }
    })

    const reset = workflow.reset({ sessionId: 'app-session', cwd: '/workspace' })
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledOnce())
    continueAdoption()

    await expect(reset).resolves.toMatchObject({
      sessionId: 'app-session',
      contextReset: true
    })
  })

  it('replaces a live Claude provider Session after projecting a Specialist switch', async () => {
    const registry = new AcpSessionRegistry()
    publishSession(registry, 'app-session', attachedSession('provider-session'))
    const connection = {} as ClientConnection
    const registerSessionSpecialist = vi.fn()
    const adopt = vi.fn(async () => ({
      sessionId: 'app-session',
      cwd: '/old-workspace',
      frameworkId: 'claude-code' as const,
      contextReset: true as const
    }))
    const workflow = new AcpSessionReplacementWorkflow({
      defaultCwd: '/default-workspace',
      defaultProjectId: 'default-project',
      currentCwd: () => '/current-workspace',
      currentFrameworkId: () => 'claude-code',
      ensureConnected: vi.fn(async () => connection),
      assertCurrentConnection: vi.fn(),
      registry,
      reserveIdentity: (sessionId, publishedAppSessionId) =>
        registry.reserve({ sessionIds: [sessionId], publishedAppSessionId }),
      adopter: { adopt },
      permission: { cancelForSession: vi.fn(), clearLivePermissionProfile: vi.fn() },
      elicitation: { cancelForSession: vi.fn() },
      clearUserChoiceProvenanceForSession: vi.fn(),
      appContinuations: { delete: vi.fn() },
      promptContent: { resetSession: vi.fn() },
      releasePromptResourcesForSession: vi.fn(),
      contextUsage: { deleteSession: vi.fn() },
      interactions: { current: vi.fn(), supersedeCurrent: vi.fn() },
      resolveSpecialistIdentity: vi.fn(async () => ({
        append: 'New Specialist append',
        prefix: 'New Specialist prefix'
      })),
      registerSessionSpecialist
    })

    await expect(workflow.switchSpecialist('app-session', 'new-specialist')).resolves.toEqual({
      contextReset: true
    })

    expect(registry.lookup('app-session')?.aggregate.snapshot()).toMatchObject({
      specialistId: 'new-specialist',
      specialistPrefix: 'New Specialist prefix'
    })
    expect(registerSessionSpecialist).toHaveBeenCalledWith('app-session', 'new-specialist')
    expect(adopt).toHaveBeenCalledWith(
      'app-session',
      expect.objectContaining({ specialistId: undefined })
    )
  })

  it.each(['codex', 'opencode', 'codebuddy'] as const)(
    'projects a live %s Specialist switch without replacing provider history',
    async (frameworkId) => {
      const registry = new AcpSessionRegistry()
      const dispose = vi.fn()
      publishSession(
        registry,
        'app-session',
        attachedSession('provider-session', dispose),
        frameworkId
      )
      const adopt = vi.fn()
      const registerSessionSpecialist = vi.fn()
      const workflow = new AcpSessionReplacementWorkflow({
        defaultCwd: '/workspace',
        defaultProjectId: 'project',
        currentCwd: vi.fn(),
        currentFrameworkId: () => frameworkId,
        ensureConnected: vi.fn(),
        assertCurrentConnection: vi.fn(),
        registry,
        reserveIdentity: vi.fn(),
        adopter: { adopt },
        permission: { cancelForSession: vi.fn(), clearLivePermissionProfile: vi.fn() },
        elicitation: { cancelForSession: vi.fn() },
        clearUserChoiceProvenanceForSession: vi.fn(),
        appContinuations: { delete: vi.fn() },
        promptContent: { resetSession: vi.fn() },
        releasePromptResourcesForSession: vi.fn(),
        contextUsage: { deleteSession: vi.fn() },
        interactions: { current: vi.fn(), supersedeCurrent: vi.fn() },
        resolveSpecialistIdentity: vi.fn(async () => ({
          append: 'ignored session append',
          prefix: 'New Specialist prefix'
        })),
        registerSessionSpecialist
      })

      await expect(workflow.switchSpecialist('app-session', 'new-specialist')).resolves.toEqual({
        contextReset: false
      })

      expect(dispose).not.toHaveBeenCalled()
      expect(adopt).not.toHaveBeenCalled()
      expect(registry.lookup('app-session')?.aggregate.snapshot()).toMatchObject({
        specialistId: 'new-specialist',
        specialistPrefix: 'New Specialist prefix',
        providerSessionId: 'provider-session'
      })
      expect(registerSessionSpecialist).toHaveBeenCalledWith('app-session', 'new-specialist')
    }
  )

  it('rejects a Specialist switch before mutating owner state while an interaction is live', async () => {
    const registry = new AcpSessionRegistry()
    const aggregate = registry.ensureAffinity('app-session').aggregate
    aggregate.setSpecialistId('old-specialist')
    aggregate.setSpecialistPrefix('Old Specialist prefix')
    const resolveSpecialistIdentity = vi.fn()
    const registerSessionSpecialist = vi.fn()
    const workflow = new AcpSessionReplacementWorkflow({
      defaultCwd: '/default-workspace',
      defaultProjectId: 'default-project',
      currentCwd: vi.fn(),
      currentFrameworkId: () => 'codex',
      ensureConnected: vi.fn(),
      assertCurrentConnection: vi.fn(),
      registry,
      reserveIdentity: vi.fn(),
      adopter: { adopt: vi.fn() },
      permission: { cancelForSession: vi.fn(), clearLivePermissionProfile: vi.fn() },
      elicitation: { cancelForSession: vi.fn() },
      clearUserChoiceProvenanceForSession: vi.fn(),
      appContinuations: { delete: vi.fn() },
      promptContent: { resetSession: vi.fn() },
      releasePromptResourcesForSession: vi.fn(),
      contextUsage: { deleteSession: vi.fn() },
      interactions: {
        current: vi.fn(() => ({ kind: 'prompt' }) as never),
        supersedeCurrent: vi.fn()
      },
      resolveSpecialistIdentity,
      registerSessionSpecialist
    })

    await expect(workflow.switchSpecialist('app-session', 'new-specialist')).rejects.toThrow(
      'Cannot switch specialist while the Agent is running.'
    )

    expect(aggregate.snapshot()).toMatchObject({
      specialistId: 'old-specialist',
      specialistPrefix: 'Old Specialist prefix'
    })
    expect(resolveSpecialistIdentity).not.toHaveBeenCalled()
    expect(registerSessionSpecialist).not.toHaveBeenCalled()
  })
})
