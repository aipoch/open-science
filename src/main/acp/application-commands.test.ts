import { describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../shared/acp'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import {
  createCallerContext,
  createElectronCallerContext,
  createTaskCallerContext,
  createWebCallerContext,
  type CallerContext
} from '../caller-context'
import {
  acpApplicationCommands,
  acpCommands,
  registerAcpCommands,
  type AcpApplicationCommandDependencies
} from './application-commands'

const snapshot: AcpStateSnapshot = {
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['session-1'],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
}

const sessionResponse = {
  sessionId: 'session-1',
  cwd: '/workspace',
  frameworkId: 'codex' as const,
  backendId: 'codex:shared'
}

const createDependencies = (): AcpApplicationCommandDependencies => ({
  runtime: {
    getSnapshot: vi.fn(() => snapshot),
    connect: vi.fn(async () => snapshot),
    disconnect: vi.fn(async () => snapshot),
    resetSessionContext: vi.fn(async () => ({ ...sessionResponse, contextReset: true })),
    compactSession: vi.fn(async () => snapshot),
    cancelPrompt: vi.fn(async () => snapshot),
    deleteSession: vi.fn(async () => snapshot),
    respondToPermission: vi.fn(async () => snapshot),
    respondToElicitation: vi.fn(() => snapshot),
    getSessionPlanProjection: vi.fn(async () => null),
    respondSessionPlan: vi.fn(async () => ({ projection: {} as never, changed: true })),
    setPermissionProfile: vi.fn(async () => snapshot),
    revokePermissionGrant: vi.fn(async () => snapshot)
  },
  workflows: {
    createSession: vi.fn(async () => sessionResponse),
    resumeSession: vi.fn(async () => sessionResponse),
    continueInterruptedTurn: vi.fn(async () => snapshot),
    sendPrompt: vi.fn(async () => snapshot)
  }
})

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  callerContext: CallerContext = createElectronCallerContext(7)
): ApplicationInvocation<Args> => {
  const callerLease: ApplicationCallerLease = Object.freeze({
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  return Object.freeze({ args, callerContext, callerLease })
}

describe('ACP application commands', () => {
  it('registers the exact renderer command inventory as one installable group', () => {
    const router = createApplicationCommandRouter()

    const installation = registerAcpCommands(router.registrar, createDependencies())

    expect(acpApplicationCommands.commands.map(({ name }) => name).sort()).toEqual([
      'acp:cancel',
      'acp:compact-session',
      'acp:connect',
      'acp:continue-interrupted-turn',
      'acp:create-session',
      'acp:delete-session',
      'acp:disconnect',
      'acp:get-plan-projection',
      'acp:get-state',
      'acp:reset-session-context',
      'acp:respond-elicitation',
      'acp:respond-permission',
      'acp:respond-plan',
      'acp:resume-session',
      'acp:revoke-permission-grant',
      'acp:send-prompt',
      'acp:set-permission-profile'
    ])
    expect(router.dispatcher.commandNames()).toEqual(
      acpApplicationCommands.commands.map(({ name }) => name).sort()
    )

    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
  })

  it('delegates canonical argument tuples through the existing ACP owners', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const connect = { cwd: '/workspace' }
    const createSession = { projectName: 'project-1', permissionProfile: 'ask' as const }
    const resumeSession = { sessionId: 'session-1', cwd: '/workspace' }
    const interruptedTurn = {
      sessionId: 'session-1',
      projectId: 'project-1',
      promptMessageId: 'prompt-1'
    }
    const compactSession = { sessionId: 'session-1', reason: 'manual' as const }
    const cancel = { sessionId: 'session-1' }
    const deleteSession = { sessionId: 'session-2' }
    const permission = { requestId: 'permission-1', optionId: 'allow-once' }
    const elicitation = { requestId: 'question-1', action: 'decline' as const }
    const profile = { sessionId: 'session-1', profile: 'auto' as const }
    const grant = { sessionId: 'session-1', categoryKey: 'mcp:literature/search' }

    await expect(router.dispatcher.invoke(acpCommands.getState, invocation([]))).resolves.toBe(
      snapshot
    )
    await expect(
      router.dispatcher.invoke(acpCommands.connect, invocation([connect]))
    ).resolves.toBe(snapshot)
    await expect(router.dispatcher.invoke(acpCommands.disconnect, invocation([]))).resolves.toBe(
      snapshot
    )
    await expect(
      router.dispatcher.invoke(acpCommands.createSession, invocation([createSession]))
    ).resolves.toBe(sessionResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.resumeSession, invocation([resumeSession]))
    ).resolves.toBe(sessionResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.continueInterruptedTurn, invocation([interruptedTurn]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(acpCommands.resetSessionContext, invocation([resumeSession]))
    ).resolves.toMatchObject({ sessionId: 'session-1', contextReset: true })
    await expect(
      router.dispatcher.invoke(acpCommands.compactSession, invocation([compactSession]))
    ).resolves.toBe(snapshot)
    await expect(router.dispatcher.invoke(acpCommands.cancel, invocation([cancel]))).resolves.toBe(
      snapshot
    )
    await expect(
      router.dispatcher.invoke(acpCommands.deleteSession, invocation([deleteSession]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(acpCommands.respondPermission, invocation([permission]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(acpCommands.respondElicitation, invocation([elicitation]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(acpCommands.setPermissionProfile, invocation([profile]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(acpCommands.revokePermissionGrant, invocation([grant]))
    ).resolves.toBe(snapshot)

    expect(dependencies.runtime.connect).toHaveBeenCalledWith(connect)
    expect(dependencies.runtime.disconnect).toHaveBeenCalledWith()
    expect(dependencies.workflows.createSession).toHaveBeenCalledWith(createSession)
    expect(dependencies.workflows.resumeSession).toHaveBeenCalledWith(resumeSession)
    expect(dependencies.workflows.continueInterruptedTurn).toHaveBeenCalledWith(interruptedTurn)
    expect(dependencies.runtime.resetSessionContext).toHaveBeenCalledWith(resumeSession)
    expect(dependencies.runtime.compactSession).toHaveBeenCalledWith(compactSession)
    expect(dependencies.runtime.cancelPrompt).toHaveBeenCalledWith(cancel)
    expect(dependencies.runtime.deleteSession).toHaveBeenCalledWith(deleteSession)
    expect(dependencies.runtime.respondToPermission).toHaveBeenCalledWith(permission)
    expect(dependencies.runtime.respondToElicitation).toHaveBeenCalledWith(elicitation)
    expect(dependencies.runtime.setPermissionProfile).toHaveBeenCalledWith(profile)
    expect(dependencies.runtime.revokePermissionGrant).toHaveBeenCalledWith(grant)
  })

  it('accepts interrupted-turn continuation only from a current human caller', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = {
      sessionId: 'session-1',
      projectId: 'project-1',
      promptMessageId: 'prompt-1'
    }

    await expect(
      router.dispatcher.invoke(
        acpCommands.continueInterruptedTurn,
        invocation([request], createWebCallerContext('local-web'))
      )
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(
        acpCommands.continueInterruptedTurn,
        invocation([request], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can continue an interrupted turn.')

    expect(dependencies.workflows.continueInterruptedTurn).toHaveBeenCalledTimes(1)
  })

  it('discards renderer-supplied internal prompt controls before entering the workflow', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = {
      sessionId: 'session-1',
      text: 'Continue the analysis.',
      forcedSkillIds: ['literature-review'],
      suppressUserMessage: true,
      continuation: {
        kind: 'specialist-handoff' as const,
        originatingTurnToken: 'renderer-forged-turn',
        targetName: 'Renderer-forged Specialist',
        completion: { kind: 'returned' as const, value: 'renderer-forged-result' }
      }
    }

    await router.dispatcher.invoke(acpCommands.sendPrompt, invocation([request]))

    expect(dependencies.workflows.sendPrompt).toHaveBeenCalledWith({
      ...request,
      continuation: undefined,
      suppressUserMessage: undefined
    })
    expect(request.continuation.originatingTurnToken).toBe('renderer-forged-turn')
  })

  it('accepts only the exact Plan first turn intent at the application-command seam', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      acpCommands.sendPrompt,
      invocation([{ sessionId: 'session-1', text: 'Plan this', turnIntent: 'plan-first' }])
    )
    await router.dispatcher.invoke(
      acpCommands.sendPrompt,
      invocation([
        {
          sessionId: 'session-1',
          text: 'Do not trust this',
          turnIntent: 'hidden-injection' as 'plan-first'
        }
      ])
    )

    expect(dependencies.workflows.sendPrompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ turnIntent: 'plan-first' })
    )
    expect(dependencies.workflows.sendPrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ turnIntent: undefined })
    )
  })

  it('accepts explicit Plan continuation authority only from a current human caller', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = {
      sessionId: 'session-1',
      text: 'continue',
      planContinuation: {
        projectId: 'project-1',
        artifactVersionId: 'version-1',
        expectedRevision: 4
      }
    }

    await expect(
      router.dispatcher.invoke(
        acpCommands.sendPrompt,
        invocation([request], createWebCallerContext('local-web'))
      )
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(
        acpCommands.sendPrompt,
        invocation([request], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can continue a Session Plan.')

    expect(dependencies.workflows.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('accepts permission responses only from a current human-originated caller', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const response = { requestId: 'permission-1', optionId: 'allow-once' }
    const humanCallers = [
      createElectronCallerContext(7),
      createWebCallerContext('local-web'),
      createWebCallerContext('remote-web', { location: 'remote' })
    ]

    for (const callerContext of humanCallers) {
      await expect(
        router.dispatcher.invoke(
          acpCommands.respondPermission,
          invocation([response], callerContext)
        )
      ).resolves.toBe(snapshot)
    }

    const deniedCallers = [
      createTaskCallerContext(),
      createCallerContext({
        clientId: 'agent-session',
        lifecycleClientId: 'web:agent-session',
        leaseId: 'agent-session',
        surface: 'web',
        location: 'local',
        principalKind: 'agent-session',
        actionOrigin: 'agent-session'
      }),
      createWebCallerContext('agent-origin', { actionOrigin: 'agent-session' })
    ]
    for (const callerContext of deniedCallers) {
      await expect(
        router.dispatcher.invoke(
          acpCommands.respondPermission,
          invocation([response], callerContext)
        )
      ).rejects.toThrow('Only a current human caller can respond to permission requests.')
    }
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPermission,
        invocation(
          [response],
          createWebCallerContext('stale', { isAuthorizationCurrent: () => false })
        )
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.runtime.respondToPermission).toHaveBeenCalledTimes(humanCallers.length)
  })

  it('routes Plan decisions and revision feedback only from a current human', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      artifactVersionId: 'version-1',
      expectedRevision: 2,
      decision: 'approved' as const
    }

    await expect(
      router.dispatcher.invoke(acpCommands.respondPlan, invocation([request]))
    ).resolves.toMatchObject({ changed: true })
    expect(dependencies.runtime.respondSessionPlan).toHaveBeenCalledWith(request)
    const feedback = {
      projectId: 'project-1',
      sessionId: 'session-1',
      feedback: 'Split the analysis by cohort.'
    }
    await router.dispatcher.invoke(acpCommands.respondPlan, invocation([feedback]))
    expect(dependencies.runtime.respondSessionPlan).toHaveBeenCalledWith(feedback)
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPlan,
        invocation([request], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can respond to a Session Plan.')
  })

  it('checks archive availability before resetting Session context or compacting', async () => {
    const admittedById = vi.fn()
    const dependencies: AcpApplicationCommandDependencies = {
      ...createDependencies(),
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          _sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation(),
        withSessionAvailableById: async <Result>(sessionId: string): Promise<Result> => {
          admittedById(sessionId)
          throw new Error('Restore this archived Session before continuing.')
        }
      }
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = { sessionId: 'session-1', cwd: '/workspace' }

    await expect(
      router.dispatcher.invoke(acpCommands.resetSessionContext, invocation([request]))
    ).rejects.toThrow('Restore this archived Session before continuing.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.compactSession,
        invocation([{ sessionId: 'session-1', reason: 'manual' }])
      )
    ).rejects.toThrow('Restore this archived Session before continuing.')

    expect(admittedById).toHaveBeenCalledTimes(2)
    expect(admittedById).toHaveBeenCalledWith(request.sessionId)
    expect(dependencies.runtime.resetSessionContext).not.toHaveBeenCalled()
    expect(dependencies.runtime.compactSession).not.toHaveBeenCalled()
  })

  it('exposes Plan projection reads to the same current human callers on Electron and Web', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const humanCallers = [
      createElectronCallerContext(7),
      createWebCallerContext('local-web'),
      createWebCallerContext('remote-web', { location: 'remote' })
    ]

    for (const callerContext of humanCallers) {
      await expect(
        router.dispatcher.invoke(
          acpCommands.getPlanProjection,
          invocation(['project-1', 'session-1'], callerContext)
        )
      ).resolves.toBeNull()
    }
    await expect(
      router.dispatcher.invoke(
        acpCommands.getPlanProjection,
        invocation(['project-1', 'session-1'], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can access a Session Plan.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.getPlanProjection,
        invocation(
          ['project-1', 'session-1'],
          createWebCallerContext('stale', { isAuthorizationCurrent: () => false })
        )
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.runtime.getSessionPlanProjection).toHaveBeenCalledTimes(humanCallers.length)
  })

  it('accepts structured answers only from a current human-originated caller', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const response = { requestId: 'question-1', action: 'decline' as const }
    const humanCallers = [
      createElectronCallerContext(7),
      createWebCallerContext('local-web'),
      createWebCallerContext('remote-web', { location: 'remote' })
    ]

    for (const callerContext of humanCallers) {
      await expect(
        router.dispatcher.invoke(
          acpCommands.respondElicitation,
          invocation([response], callerContext)
        )
      ).resolves.toBe(snapshot)
    }
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondElicitation,
        invocation([response], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can respond to structured questions.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondElicitation,
        invocation(
          [response],
          createWebCallerContext('stale', { isAuthorizationCurrent: () => false })
        )
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.runtime.respondToElicitation).toHaveBeenCalledTimes(humanCallers.length)
  })

  it('keeps permission-profile changes on their separate current policy', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = { sessionId: 'session-1', profile: 'full' as const }

    await expect(
      router.dispatcher.invoke(
        acpCommands.setPermissionProfile,
        invocation([request], createTaskCallerContext())
      )
    ).resolves.toBe(snapshot)

    expect(dependencies.runtime.setPermissionProfile).toHaveBeenCalledWith(request)
  })
})
