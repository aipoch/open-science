import { describe, expect, it, vi } from 'vitest'

import type { AcpStateSnapshot } from '../../shared/acp'
import { toAcpStateCommandResponse } from '../../shared/acp'
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
  revision: 1,
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
const commandResponse = toAcpStateCommandResponse(snapshot)

const sessionResponse = {
  sessionId: 'session-1',
  cwd: '/workspace',
  frameworkId: 'codex' as const,
  backendId: 'codex:shared'
}

const createDependencies = (): AcpApplicationCommandDependencies => ({
  runtime: {
    getSnapshot: vi.fn(() => snapshot),
    getState: vi.fn(() => ({ ...commandResponse.result, revision: commandResponse.revision })),
    connect: vi.fn(async () => snapshot),
    disconnect: vi.fn(async () => snapshot),
    resetSessionContext: vi.fn(async () => ({ ...sessionResponse, contextReset: true })),
    compactSession: vi.fn(async () => snapshot),
    cancelPrompt: vi.fn(async () => snapshot),
    steerFollowUp: vi.fn(async () => ({
      injected: false as const,
      reason: 'not-advertised' as const
    })),
    deleteSession: vi.fn(async () => snapshot),
    respondToPermission: vi.fn(async () => snapshot),
    respondToElicitation: vi.fn(async () => snapshot),
    getSessionPlanProjection: vi.fn(async () => null),
    respondSessionPlan: vi.fn(async () => ({ projection: {} as never, changed: true })),
    setPermissionProfile: vi.fn(async () => snapshot),
    revokePermissionGrant: vi.fn(async () => snapshot)
  },
  workflows: {
    createSession: vi.fn(async () => sessionResponse),
    resumeSession: vi.fn(async () => sessionResponse),
    continueInterruptedTurn: vi.fn(async () => snapshot),
    saveAsSkill: vi.fn(async () => snapshot),
    sendPrompt: vi.fn(async () => snapshot)
  }
})

const ownerResolvingArchiveAvailability = (
  projectId: string
): NonNullable<AcpApplicationCommandDependencies['archiveAvailability']> => ({
  withSessionAvailable: async <Result>(
    _projectId: string,
    _sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> => operation(),
  withSessionAvailableById: async <Result>(
    _sessionId: string,
    operation: (ownerProjectId: string) => Promise<Result>
  ): Promise<Result> => operation(projectId)
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
  it('routes delegated question responses to the delegated owner without calling Main elicitation', async () => {
    const dependencies = createDependencies()
    const respondDelegatedQuestion = vi.fn(async () => undefined)
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, { ...dependencies, respondDelegatedQuestion })
    const response = {
      requestId: 'delegated-question-1',
      action: 'accept' as const,
      delegatedQuestion: {
        projectId: 'project-1',
        sessionId: 'session-1',
        action: 'confirm' as const,
        answers: [{ questionIndex: 0, value: 'Strict' }]
      }
    }

    await expect(
      router.dispatcher.invoke(acpCommands.respondElicitation, invocation([response]))
    ).resolves.toEqual(commandResponse)
    expect(respondDelegatedQuestion).toHaveBeenCalledWith({
      ...response.delegatedQuestion,
      requestId: response.requestId
    })
    expect(dependencies.runtime.respondToElicitation).not.toHaveBeenCalled()
  })

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
      'acp:save-as-skill',
      'acp:send-prompt',
      'acp:set-permission-profile',
      'acp:steer-follow-up'
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
    const createSession = { projectId: 'project-1', permissionProfile: 'ask' as const }
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
    ).resolves.toEqual(commandResponse)
    await expect(router.dispatcher.invoke(acpCommands.disconnect, invocation([]))).resolves.toEqual(
      commandResponse
    )
    await expect(
      router.dispatcher.invoke(acpCommands.createSession, invocation([createSession]))
    ).resolves.toBe(sessionResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.resumeSession, invocation([resumeSession]))
    ).resolves.toBe(sessionResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.continueInterruptedTurn, invocation([interruptedTurn]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.resetSessionContext, invocation([resumeSession]))
    ).resolves.toMatchObject({ sessionId: 'session-1', contextReset: true })
    await expect(
      router.dispatcher.invoke(acpCommands.compactSession, invocation([compactSession]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.cancel, invocation([cancel]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.deleteSession, invocation([deleteSession]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.respondPermission, invocation([permission]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.respondElicitation, invocation([elicitation]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.setPermissionProfile, invocation([profile]))
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(acpCommands.revokePermissionGrant, invocation([grant]))
    ).resolves.toEqual(commandResponse)

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
    ).resolves.toEqual(commandResponse)
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

  it('accepts Save as skill only from a current human caller', async () => {
    const dependencies = createDependencies()
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      agentFrameId: 'root-frame',
      messageBranchId: 'active-branch',
      promptMessageId: 'save-as-skill-control'
    }

    await expect(
      router.dispatcher.invoke(
        acpCommands.saveAsSkill,
        invocation([request], createWebCallerContext('local-web'))
      )
    ).resolves.toEqual(commandResponse)
    await expect(
      router.dispatcher.invoke(
        acpCommands.saveAsSkill,
        invocation([request], createTaskCallerContext())
      )
    ).rejects.toThrow('Only a current human caller can save a Session as a Skill.')

    expect(dependencies.workflows.saveAsSkill).toHaveBeenCalledOnce()
    expect(dependencies.workflows.saveAsSkill).toHaveBeenCalledWith(request)
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
      ).resolves.toEqual(commandResponse)
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

  it('routes Plan decisions and revision feedback from current humans and Task automation', async () => {
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
    ).resolves.toMatchObject({ changed: true })
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPlan,
        invocation([request], createTaskCallerContext({ isAuthorizationCurrent: () => false }))
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPlan,
        invocation(
          [request],
          createWebCallerContext('agent-origin', { actionOrigin: 'agent-session' })
        )
      )
    ).rejects.toThrow(
      'Only a current human or Task automation caller can respond to a Session Plan.'
    )
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

  it('binds Web reset requests to the persisted Project owner', async () => {
    const persistedProjectId = 'persisted-project'
    const dependencies: AcpApplicationCommandDependencies = {
      ...createDependencies(),
      archiveAvailability: ownerResolvingArchiveAvailability(persistedProjectId)
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)
    const request = { sessionId: 'session-1', cwd: '/workspace' }

    await router.dispatcher.invoke(
      acpCommands.resetSessionContext,
      invocation([request], createWebCallerContext('local-web'))
    )

    expect(dependencies.runtime.resetSessionContext).toHaveBeenCalledWith({
      ...request,
      projectId: persistedProjectId
    })
  })

  it('rejects a Web reset request whose projectId disagrees with the persisted owner', async () => {
    const persistedProjectId = 'persisted-project'
    const dependencies: AcpApplicationCommandDependencies = {
      ...createDependencies(),
      archiveAvailability: ownerResolvingArchiveAvailability(persistedProjectId)
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        acpCommands.resetSessionContext,
        invocation(
          [
            {
              sessionId: 'session-1',
              cwd: '/workspace',
              projectId: 'forged-project'
            }
          ],
          createWebCallerContext('local-web')
        )
      )
    ).rejects.toThrow('Session does not belong to the requested Project.')

    expect(dependencies.runtime.resetSessionContext).not.toHaveBeenCalled()
  })

  it('does not nest Session admission around the coordinator follow-up guard', async () => {
    let archiveQueue: Promise<void> = Promise.resolve()
    const enqueueArchive = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = archiveQueue.then(operation, operation)
      archiveQueue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
    const base = createDependencies()
    const withSessionAvailableById = <Result>(
      _sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result> => enqueueArchive(() => operation('project-1'))
    const dependencies: AcpApplicationCommandDependencies = {
      ...base,
      runtime: {
        ...base.runtime,
        steerFollowUp: vi.fn(() =>
          withSessionAvailableById('session-1', async () => ({
            injected: false as const,
            reason: 'prompt-required' as const
          }))
        )
      },
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          _sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation(),
        withSessionAvailableById
      }
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)

    const outcome = await router.dispatcher.invoke(
      acpCommands.steerFollowUp,
      invocation([{ sessionId: 'session-1', text: 'focus on tests' }])
    )

    expect(outcome).toEqual({ injected: false, reason: 'prompt-required' })
    expect(dependencies.runtime.steerFollowUp).toHaveBeenCalledOnce()
  })

  it('holds Session admission through ACP response mutations', async () => {
    const responseSnapshot: AcpStateSnapshot = {
      ...snapshot,
      pendingPermissions: [
        {
          requestId: 'permission-1',
          sessionId: 'permission-session',
          toolCallId: 'tool-1',
          title: 'Use a tool',
          options: []
        }
      ],
      pendingElicitations: [
        {
          requestId: 'question-1',
          sessionId: 'elicitation-session',
          toolCallId: 'tool-2',
          message: 'Choose',
          fields: []
        }
      ]
    }
    let admittedSessionId: string | undefined
    const admitted: string[] = []
    const withinAdmission = async <Result>(
      sessionId: string,
      operation: () => Promise<Result>
    ): Promise<Result> => {
      expect(admittedSessionId).toBeUndefined()
      admittedSessionId = sessionId
      admitted.push(sessionId)
      try {
        return await operation()
      } finally {
        admittedSessionId = undefined
      }
    }
    const base = createDependencies()
    const runtime: AcpApplicationCommandDependencies['runtime'] = {
      ...base.runtime,
      getSnapshot: vi.fn(() => responseSnapshot),
      respondToPermission: vi.fn(async (response) => {
        expect(admittedSessionId).toBe(
          response.requestId === 'restored-permission'
            ? 'restored-permission-session'
            : 'permission-session'
        )
        return responseSnapshot
      }),
      respondToElicitation: vi.fn(async (response) => {
        expect(admittedSessionId).toBe(
          response.requestId === 'restored-question'
            ? 'restored-elicitation-session'
            : 'elicitation-session'
        )
        return responseSnapshot
      }),
      respondSessionPlan: vi.fn(async () => {
        expect(admittedSessionId).toBe('plan-session')
        return { projection: {} as never, changed: true }
      }),
      setPermissionProfile: vi.fn(async () => {
        expect(admittedSessionId).toBe('profile-session')
        return responseSnapshot
      }),
      revokePermissionGrant: vi.fn(async () => {
        expect(admittedSessionId).toBe('profile-session')
        return responseSnapshot
      })
    }
    const respondDelegatedQuestion = vi.fn(async () => {
      expect(admittedSessionId).toBe('delegated-session')
    })
    const dependencies: AcpApplicationCommandDependencies = {
      ...base,
      runtime,
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => withinAdmission(sessionId, operation),
        withSessionAvailableById: (sessionId, operation) =>
          withinAdmission(sessionId, () => operation('project-1'))
      },
      respondDelegatedQuestion
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)

    await router.dispatcher.invoke(
      acpCommands.respondPermission,
      invocation([{ requestId: 'permission-1', optionId: 'allow-once' }])
    )
    await router.dispatcher.invoke(
      acpCommands.respondElicitation,
      invocation([{ requestId: 'question-1', action: 'decline' }])
    )
    await router.dispatcher.invoke(
      acpCommands.respondPermission,
      invocation([
        {
          requestId: 'restored-permission',
          optionId: 'allow-once',
          restored: {
            projectId: 'project-1',
            sessionId: 'restored-permission-session'
          }
        }
      ])
    )
    await router.dispatcher.invoke(
      acpCommands.respondElicitation,
      invocation([
        {
          requestId: 'restored-question',
          action: 'decline',
          request: {
            requestId: 'restored-question',
            sessionId: 'restored-elicitation-session',
            toolCallId: 'tool-restored',
            message: 'Choose again',
            fields: []
          }
        }
      ])
    )
    await router.dispatcher.invoke(
      acpCommands.respondElicitation,
      invocation([
        {
          requestId: 'delegated-question-1',
          action: 'accept',
          delegatedQuestion: {
            projectId: 'project-1',
            sessionId: 'delegated-session',
            action: 'confirm',
            answers: []
          }
        }
      ])
    )
    await router.dispatcher.invoke(
      acpCommands.respondPlan,
      invocation([
        {
          projectId: 'project-1',
          sessionId: 'plan-session',
          feedback: 'Revise the plan.'
        }
      ])
    )
    await router.dispatcher.invoke(
      acpCommands.setPermissionProfile,
      invocation([{ sessionId: 'profile-session', profile: 'auto' }])
    )
    await router.dispatcher.invoke(
      acpCommands.revokePermissionGrant,
      invocation([{ sessionId: 'profile-session', categoryKey: 'mcp:tool' }])
    )

    expect(admitted).toEqual([
      'permission-session',
      'elicitation-session',
      'restored-permission-session',
      'restored-elicitation-session',
      'delegated-session',
      'plan-session',
      'profile-session',
      'profile-session'
    ])
    expect(respondDelegatedQuestion).toHaveBeenCalledOnce()
  })

  it('rejects forged and unknown ACP response authority before Session admission', async () => {
    const responseSnapshot: AcpStateSnapshot = {
      ...snapshot,
      sessionIds: ['permission-session', 'elicitation-session', 'forged-session'],
      pendingPermissions: [
        {
          requestId: 'permission-1',
          sessionId: 'permission-session',
          toolCallId: 'tool-1',
          title: 'Use a tool',
          options: []
        }
      ],
      pendingElicitations: [
        {
          requestId: 'question-1',
          sessionId: 'elicitation-session',
          toolCallId: 'tool-2',
          message: 'Choose',
          fields: []
        }
      ]
    }
    const base = createDependencies()
    const admitted: string[] = []
    const withSessionAvailableById = <Result>(
      sessionId: string,
      operation: (projectId: string) => Promise<Result>
    ): Promise<Result> => {
      admitted.push(sessionId)
      return operation('project-1')
    }
    const respondDelegatedQuestion = vi.fn(async () => undefined)
    const dependencies: AcpApplicationCommandDependencies = {
      ...base,
      runtime: {
        ...base.runtime,
        getSnapshot: vi.fn(() => responseSnapshot)
      },
      archiveAvailability: {
        withSessionAvailable: async <Result>(
          _projectId: string,
          _sessionId: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation(),
        withSessionAvailableById
      },
      respondDelegatedQuestion
    }
    const router = createApplicationCommandRouter()
    registerAcpCommands(router.registrar, dependencies)

    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPermission,
        invocation([
          {
            requestId: 'permission-1',
            optionId: 'allow-once',
            restored: { projectId: 'forged-project', sessionId: 'forged-session' }
          }
        ])
      )
    ).rejects.toThrow('Permission response Session does not match the pending request.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondElicitation,
        invocation([
          {
            requestId: 'question-1',
            action: 'decline',
            request: {
              requestId: 'question-1',
              sessionId: 'forged-session',
              toolCallId: 'tool-2',
              message: 'Choose',
              fields: []
            }
          }
        ])
      )
    ).rejects.toThrow('Structured input response Session does not match the pending request.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondElicitation,
        invocation([
          {
            requestId: 'question-1',
            action: 'accept',
            delegatedQuestion: {
              projectId: 'forged-project',
              sessionId: 'forged-session',
              action: 'confirm',
              answers: []
            }
          }
        ])
      )
    ).rejects.toThrow('Structured input response Session does not match the pending request.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondPermission,
        invocation([{ requestId: 'unknown-permission', optionId: 'allow-once' }])
      )
    ).rejects.toThrow('Unknown permission request.')
    await expect(
      router.dispatcher.invoke(
        acpCommands.respondElicitation,
        invocation([{ requestId: 'unknown-question', action: 'decline' }])
      )
    ).rejects.toThrow('Unknown structured input request.')

    expect(admitted).toEqual([])
    expect(dependencies.runtime.respondToPermission).not.toHaveBeenCalled()
    expect(dependencies.runtime.respondToElicitation).not.toHaveBeenCalled()
    expect(respondDelegatedQuestion).not.toHaveBeenCalled()
  })

  it('exposes Plan projection reads to current humans and Task automation', async () => {
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
    ).resolves.toBeNull()
    await expect(
      router.dispatcher.invoke(
        acpCommands.getPlanProjection,
        invocation(
          ['project-1', 'session-1'],
          createWebCallerContext('stale', { isAuthorizationCurrent: () => false })
        )
      )
    ).rejects.toThrow('Caller authorization is no longer current.')

    expect(dependencies.runtime.getSessionPlanProjection).toHaveBeenCalledTimes(
      humanCallers.length + 1
    )
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
      ).resolves.toEqual(commandResponse)
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
    ).resolves.toEqual(commandResponse)

    expect(dependencies.runtime.setPermissionProfile).toHaveBeenCalledWith(request)
  })
})
