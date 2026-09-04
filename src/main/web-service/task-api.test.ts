import { describe, expect, it, vi, type MockedFunction } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import {
  attachEnabledComputeHosts,
  EnabledComputeHostsRegistry
} from '../compute/enabled-hosts-registry'
import {
  sessionComputeHostAccess,
  transitionSessionComputeHostAccess,
  type SessionComputeHostAccessMutation
} from '../compute/session-compute-host-access'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import type { TaskAgentPort, TaskSessionPort } from '../tasks/task-runner'
import { HeadlessTaskApi } from './task-api'

const project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const taskCallerContext = (): ReturnType<typeof expect.objectContaining> =>
  expect.objectContaining({
    clientId: 'headless-task-api',
    lifecycleClientId: 'web:headless-task-api',
    surface: 'task',
    principalKind: 'automation',
    actionOrigin: 'automation'
  })

const taskSettings = {
  claude: {},
  opencode: {},
  codebuddy: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codebuddyManaged: false,
  codexManaged: false,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
}

type TaskAgentMock = {
  [Method in Exclude<keyof TaskAgentPort, 'withSessionAvailable'>]: MockedFunction<
    TaskAgentPort[Method]
  >
} & Pick<TaskAgentPort, 'withSessionAvailable'>

const createAgent = (overrides: Partial<TaskAgentMock> = {}): TaskAgentMock => ({
  withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
  listAttachedSessionIds: vi.fn<TaskAgentPort['listAttachedSessionIds']>(async () => []),
  createSession: vi.fn<TaskAgentPort['createSession']>(async () => ({
    sessionId: 'session-created'
  })),
  resumeSession: vi.fn<TaskAgentPort['resumeSession']>(async (request) => ({
    sessionId: request.sessionId
  })),
  setPermissionProfile: vi.fn<TaskAgentPort['setPermissionProfile']>(async () => undefined),
  setMemoryEnabled: vi.fn<TaskAgentPort['setMemoryEnabled']>(async () => undefined),
  prompt: vi.fn<TaskAgentPort['prompt']>(async () => undefined),
  cancelPrompt: vi.fn<TaskAgentPort['cancelPrompt']>(async () => undefined),
  ...overrides
})

const commandsFrom = (
  invoke: (channel: string, callerContext: CallerContext, args: unknown[]) => Promise<unknown>
): ApplicationCommandByNameDispatcher => {
  const sessions = new Map<string, PersistedChatSession>()
  return {
    commandNames: () => [],
    invoke: async (channel, invocation) => {
      const args = [...invocation.args]
      if (channel === 'settings:get-settings') return taskSettings
      try {
        const result = await invoke(channel, invocation.callerContext, args)
        if (channel === 'sessions:load-all') {
          for (const session of (result as { sessions?: PersistedChatSession[] })?.sessions ?? []) {
            sessions.set(session.id, structuredClone(session))
          }
        } else if (channel === 'sessions:save-session') {
          const saved = (result ?? args[0]) as PersistedChatSession
          sessions.set(saved.id, structuredClone(saved))
        }
        if (result !== undefined) return result
      } catch (error) {
        if (
          !channel.startsWith('sessions:') ||
          ![
            'sessions:stage-task-completion',
            'sessions:settle-task-completion',
            'sessions:fail-task-run'
          ].includes(channel) ||
          !(error instanceof Error && error.message.startsWith('Unexpected Task command:'))
        ) {
          throw error
        }
      }

      if (channel === 'sessions:stage-task-completion') {
        const request = args[0] as Parameters<TaskSessionPort['stageCompletion']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        if (request.message) current.messages.push(request.message)
        current.activities = [...(current.activities ?? []), ...request.activities]
        if (request.clearPendingHistoryReplay) delete current.pendingHistoryReplay
        current.updatedAt = request.updatedAt
        sessions.set(current.id, current)
        return current
      }
      if (channel === 'sessions:settle-task-completion') {
        const request = args[0] as Parameters<TaskSessionPort['settleCompletion']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        current.status = 'idle'
        delete current.activeRun
        current.taskRunCommitId = request.taskRunCommitId
        current.artifacts = [...(current.artifacts ?? []), ...request.artifacts]
        sessions.set(current.id, current)
        return current
      }
      if (channel === 'sessions:fail-task-run') {
        const request = args[0] as Parameters<TaskSessionPort['failRun']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        current.status = 'error'
        current.error = request.error
        delete current.activeRun
        current.taskRunCommitId = request.taskRunCommitId
        sessions.set(current.id, current)
        return current
      }
      return undefined
    }
  }
}

const createComputePreferenceHarness = (
  existingSession?: PersistedChatSession
): {
  api: HeadlessTaskApi
  agent: TaskAgentMock
  durableSessions: Map<string, PersistedChatSession>
  registry: EnabledComputeHostsRegistry
  saveSession: MockedFunction<(session: PersistedChatSession) => Promise<void>>
} => {
  const durableSessions = new Map<string, PersistedChatSession>()
  if (existingSession) durableSessions.set(existingSession.id, structuredClone(existingSession))

  const saveSession = vi.fn(async (value: PersistedChatSession) => {
    durableSessions.set(value.id, structuredClone(value))
  })
  const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
  const invoke = vi.fn(async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
    if (channel === 'projects:list') return [project]
    if (channel === 'sessions:load-all') {
      return {
        sessions: [...durableSessions.values()].map((session) => structuredClone(session)),
        manifest: { version: 1 }
      }
    }
    if (channel === 'sessions:save-session') {
      const session = args[0] as PersistedChatSession
      if (!durableSessions.has(session.id)) {
        return ownerRef.current!.createSession(session, async (candidate) => {
          await saveSession(candidate)
          return candidate
        })
      }
      await saveSession(session)
      return session
    }
    throw new Error(`Unexpected Task command: ${channel}`)
  })
  const registry = new EnabledComputeHostsRegistry()
  const owner = new SessionEnabledComputeHostsOwner({
    registry,
    hostExists: async (providerId) => ['ssh:kept', 'ssh:alpha', 'ssh:beta'].includes(providerId),
    listHostIds: async () => ['ssh:kept', 'ssh:alpha', 'ssh:beta'],
    sessionAuthority: {
      sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
      setSessionEnabledComputeHosts: async (projectId, sessionId, providerIds) => {
        const session = durableSessions.get(sessionId)
        if (!session || session.projectId !== projectId) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        const committed = { ...session, enabledComputeHosts: [...providerIds] }
        durableSessions.set(sessionId, structuredClone(committed))
        return committed
      },
      mutateSessionComputeHostAccess: async (
        projectId: string,
        sessionId: string,
        mutation: SessionComputeHostAccessMutation
      ) => {
        const session = durableSessions.get(sessionId)
        if (!session || session.projectId !== projectId) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        const access = transitionSessionComputeHostAccess(
          sessionComputeHostAccess(session),
          mutation
        )
        const committed = {
          ...session,
          enabledComputeHosts: [...access.enabledProviderIds],
          selectedComputeHosts: [...access.selectedProviderIds]
        }
        durableSessions.set(sessionId, structuredClone(committed))
        return committed
      },
      pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
    },
    withDataRootWrite: (operation) => operation()
  })
  ownerRef.current = owner
  if (existingSession) owner.project(existingSession)

  const agent = createAgent({
    createSession: vi.fn(async () => ({ sessionId: 'session-created', cwd: '/workspace' }))
  })
  let nextId = 0
  const api = new HeadlessTaskApi(
    { commands: commandsFrom(invoke), agent, computePreferences: owner },
    { createId: () => `task-id-${++nextId}`, now: () => 10 }
  )
  return { api, agent, durableSessions, registry, saveSession }
}

describe('HeadlessTaskApi adapter', () => {
  it('routes Project Session defaults through the Task-only persistence command', async () => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'projects:update-session-defaults') {
          return { ...project, ...(args[0] as object), updatedAt: 2 }
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await api.updateProjectSessionDefaults(project.id, {
      expectedUpdatedAt: project.updatedAt,
      patch: { memoryEnabled: false }
    })

    expect(invoke).toHaveBeenCalledWith('projects:update-session-defaults', taskCallerContext(), [
      {
        id: project.id,
        expectedUpdatedAt: project.updatedAt,
        sessionDefaults: { memoryEnabled: false }
      }
    ])
  })

  it('routes Session configuration updates through the Task-only atomic command', async () => {
    const existing: PersistedChatSession = {
      id: 'session-config',
      projectId: project.id,
      title: 'Configurable Session',
      cwd: '/workspace',
      status: 'idle',
      revision: 4,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    let durable = existing
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'sessions:load-all') {
          return { sessions: [durable], manifest: { version: 1 } }
        }
        if (channel === 'sessions:update-configuration') {
          durable = { ...(args[0] as PersistedChatSession), revision: 5 }
          return durable
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await expect(
      api.updateSessionConfiguration(existing.id, {
        expectedRevision: 4,
        memoryEnabled: false,
        delegationPolicy: 'deny'
      })
    ).resolves.toMatchObject({
      revision: 5,
      persisted: { memoryEnabled: false, delegationPolicy: 'deny' }
    })
    expect(invoke).toHaveBeenCalledWith('sessions:update-configuration', taskCallerContext(), [
      expect.objectContaining({
        id: existing.id,
        memoryEnabled: false,
        delegationPolicy: 'deny'
      }),
      4
    ])
  })

  it('creates a new Session when persistence and Task share one Compute preference owner', async () => {
    const durableSessions = new Map<string, PersistedChatSession>()
    const registry = new EnabledComputeHostsRegistry()
    let newSessionSaveEntries = 0
    let durableCommitCalls = 0
    const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return { sessions: [...durableSessions.values()], manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') {
          const session = args[0] as PersistedChatSession
          if (!durableSessions.has(session.id)) newSessionSaveEntries += 1
          const durable = durableSessions.has(session.id)
            ? session
            : await ownerRef.current!.createSession(session, async (candidate) => {
                durableCommitCalls += 1
                durableSessions.set(candidate.id, structuredClone(candidate))
                return candidate
              })
          durableSessions.set(durable.id, structuredClone(durable))
          return durable
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:alpha',
      listHostIds: async () => ['ssh:alpha'],
      sessionAuthority: {
        sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('Unexpected existing Session update.')
        },
        pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
      },
      withDataRootWrite: (operation) => operation()
    })
    ownerRef.current = owner
    const api = new HeadlessTaskApi(
      {
        commands: commandsFrom(invoke),
        agent: createAgent({
          createSession: vi.fn(async () => ({ sessionId: 'session-created', cwd: '/workspace' }))
        }),
        computePreferences: owner
      },
      { createId: () => 'task-id', now: () => 10 }
    )

    const outcome = await api.startRun({
      project: project.id,
      prompt: 'Research this.',
      computeHostIds: ['ssh:alpha']
    })

    expect(outcome).toMatchObject({ sessionId: 'session-created' })
    expect(newSessionSaveEntries).toBe(1)
    expect(durableCommitCalls).toBe(1)
    expect(durableSessions.get('session-created')?.enabledComputeHosts).toEqual(['ssh:alpha'])
    expect(durableSessions.get('session-created')?.selectedComputeHosts).toEqual(['ssh:alpha'])
    expect(registry.getEnabled('session-created')).toEqual(['ssh:alpha'])
    expect(registry.getSelected('session-created')).toEqual(['ssh:alpha'])
    await api.dispose()
  }, 1_000)

  it('keeps the selected Compute Host visible to five Sessions initialized concurrently', async () => {
    const concurrency = 5
    const durableSessions = new Map<string, PersistedChatSession>()
    const registry = new EnabledComputeHostsRegistry()
    const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
    const creationIndexBySessionId = new Map<string, number>()

    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return ownerRef.current!.hydrateFromSessionCatalog(async () => ({
            sessions: [...durableSessions.values()].map((session) => structuredClone(session)),
            manifest: { version: 1 as const },
            diagnostics: {
              isComplete: true,
              warnings: [],
              isProjectDeletionRecoveryComplete: true
            }
          }))
        }
        if (channel === 'sessions:save-session') {
          const session = args[0] as PersistedChatSession
          const sessionIndex = creationIndexBySessionId.get(session.id)
          if (sessionIndex === undefined) throw new Error(`Unknown Session: ${session.id}`)
          const committed = await ownerRef.current!.createSession(session, async (candidate) => {
            durableSessions.set(candidate.id, structuredClone(candidate))
            return candidate
          })
          return committed
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:alpha',
      listHostIds: async () => ['ssh:alpha'],
      sessionAuthority: {
        sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('Unexpected existing Session update.')
        },
        mutateSessionComputeHostAccess: async () => {
          throw new Error('Unexpected existing Session mutation.')
        },
        pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
      },
      withDataRootWrite: (operation) => operation()
    })
    ownerRef.current = owner
    const compute = attachEnabledComputeHosts({}, registry)
    const allPromptsEntered = Promise.withResolvers<void>()
    let promptCount = 0
    const visibleHosts = new Map<string, string[]>()
    let nextSessionId = 0
    const agent = createAgent({
      createSession: vi.fn(async () => {
        const creationIndex = nextSessionId++
        const sessionId = `session-${creationIndex + 1}`
        creationIndexBySessionId.set(sessionId, creationIndex)
        return { sessionId, cwd: '/workspace' }
      }),
      prompt: vi.fn(async ({ sessionId }) => {
        promptCount += 1
        if (promptCount === concurrency) allPromptsEntered.resolve()
        await allPromptsEntered.promise
        visibleHosts.set(sessionId, compute.getSelectedComputeHosts(sessionId))
      })
    })
    let nextId = 0
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent, computePreferences: owner },
      { createId: () => `task-id-${++nextId}`, now: () => 10 }
    )

    const started = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        api.startRun({
          project: project.id,
          prompt: `Research stream ${index + 1}.`,
          computeHostIds: ['ssh:alpha']
        })
      )
    )
    await Promise.all(started.map(({ id }) => api.waitForRun(id)))
    await api.dispose()

    expect({
      durable: started.map(({ sessionId }) => {
        const persisted = durableSessions.get(sessionId)
        return {
          enabledComputeHosts: persisted?.enabledComputeHosts,
          selectedComputeHosts: persisted?.selectedComputeHosts
        }
      }),
      runtime: started.map(({ sessionId }) => visibleHosts.get(sessionId))
    }).toEqual({
      durable: Array.from({ length: concurrency }, () => ({
        enabledComputeHosts: ['ssh:alpha'],
        selectedComputeHosts: ['ssh:alpha']
      })),
      runtime: Array.from({ length: concurrency }, () => ['ssh:alpha'])
    })
  })

  it('dispatches façade operations through the narrow Task command view', async () => {
    const commandInvoke = vi.fn(async () => [
      { ...project, agentContext: 'Do not expose this instruction.' }
    ])
    const api = new HeadlessTaskApi({
      commands: {
        commandNames: () => ['projects:list'],
        invoke: commandInvoke
      },
      agent: createAgent()
    })

    const projects = await api.listProjects()
    expect(projects).toEqual([{ ...project, hasAgentContext: true }])
    expect(JSON.stringify(projects)).not.toContain('Do not expose this instruction.')
    expect(commandInvoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        callerContext: taskCallerContext(),
        callerLease: expect.objectContaining({ leaseId: 'headless-task-api' }),
        args: []
      })
    )
  })

  it.each([
    { label: 'omits an unspecified preference', request: {}, expected: [] },
    {
      label: 'commits an explicit empty preference',
      request: { computeHostIds: [] },
      expected: []
    },
    {
      label: 'deduplicates a replacement in first-occurrence order',
      request: { computeHostIds: ['ssh:beta', 'ssh:alpha', 'ssh:beta'] },
      expected: ['ssh:beta', 'ssh:alpha']
    }
  ])(
    '$label for a new Session through the Compute preference authority',
    async ({ request, expected }) => {
      const h = createComputePreferenceHarness()

      const started = await h.api.startRun({
        project: project.id,
        prompt: 'Research this.',
        ...request
      })
      const completed = await h.api.waitForRun(started.id)

      expect(started.preferredComputeHostIds).toEqual(expected)
      expect(completed.preferredComputeHostIds).toEqual(expected)
      expect(h.durableSessions.get(started.sessionId)?.enabledComputeHosts).toEqual(
        'computeHostIds' in request ? expected : undefined
      )
      expect(h.durableSessions.get(started.sessionId)?.selectedComputeHosts).toEqual(
        'computeHostIds' in request ? expected : undefined
      )
      expect(h.registry.getEnabled(started.sessionId)).toEqual(expected)
      expect(h.registry.getSelected(started.sessionId)).toEqual(expected)
      await h.api.dispose()
    }
  )

  it.each([
    {
      label: 'preserves an omitted preference',
      request: {},
      expected: ['ssh:kept'],
      expectedEnabled: ['ssh:kept', 'ssh:available']
    },
    {
      label: 'clears an explicit empty preference',
      request: { computeHostIds: [] },
      expected: [],
      expectedEnabled: ['ssh:kept', 'ssh:available']
    },
    {
      label: 'replaces and deduplicates in first-occurrence order',
      request: { computeHostIds: ['ssh:beta', 'ssh:alpha', 'ssh:beta'] },
      expected: ['ssh:beta', 'ssh:alpha'],
      expectedEnabled: ['ssh:kept', 'ssh:available', 'ssh:beta', 'ssh:alpha']
    }
  ])(
    '$label for a continued Session through the Compute preference authority',
    async ({ request, expected, expectedEnabled }) => {
      const existing: PersistedChatSession = {
        id: 'session-existing',
        projectId: project.id,
        title: 'Existing research',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        enabledComputeHosts: ['ssh:kept', 'ssh:available'],
        selectedComputeHosts: ['ssh:kept'],
        createdAt: 1,
        updatedAt: 2
      }
      const h = createComputePreferenceHarness(existing)

      const started = await h.api.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue this research.',
        ...request
      })
      const completed = await h.api.waitForRun(started.id)

      expect(h.durableSessions.get(existing.id)?.enabledComputeHosts).toEqual(expectedEnabled)
      expect(h.durableSessions.get(existing.id)?.selectedComputeHosts).toEqual(expected)
      expect(h.registry.getEnabled(existing.id)).toEqual(expectedEnabled)
      expect(h.registry.getSelected(existing.id)).toEqual(expected)
      expect(started.preferredComputeHostIds).toEqual(expected)
      expect(completed.preferredComputeHostIds).toEqual(expected)
      await h.api.dispose()
    }
  )

  it.each([
    {
      label: 'invalid',
      providerId: 'local:alpha',
      message: 'Invalid Compute Host provider id: local:alpha'
    },
    {
      label: 'unknown',
      providerId: 'ssh:missing',
      message: 'Compute Host not found: ssh:missing'
    }
  ])(
    'rejects an $label preference atomically before continuing a Session',
    async ({ providerId, message }) => {
      const existing: PersistedChatSession = {
        id: 'session-existing',
        projectId: project.id,
        title: 'Existing research',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        enabledComputeHosts: ['ssh:kept'],
        createdAt: 1,
        updatedAt: 2
      }
      const h = createComputePreferenceHarness(existing)
      const before = structuredClone(existing)

      await expect(
        h.api.startRun({
          project: project.id,
          sessionId: existing.id,
          prompt: 'Continue this research.',
          computeHostIds: [providerId]
        })
      ).rejects.toMatchObject({ code: 'invalid_request', message })

      expect(h.durableSessions.get(existing.id)).toEqual(before)
      expect(h.registry.getEnabled(existing.id)).toEqual(['ssh:kept'])
      expect(h.registry.getSelected(existing.id)).toEqual(['ssh:kept'])
      expect(h.saveSession).not.toHaveBeenCalled()
      expect(h.agent.resumeSession).not.toHaveBeenCalled()
      expect(h.agent.prompt).not.toHaveBeenCalled()
      await h.api.dispose()
    }
  )

  it('reads and responds to a Session Plan through the Task command view', async () => {
    const persisted: PersistedChatSession = {
      id: 'session-plan',
      projectId: project.id,
      title: 'Plan session',
      cwd: '/workspace/plan',
      status: 'waiting-plan-approval',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    }
    const projection = {
      artifactId: 'plan-artifact',
      artifactVersionId: 'plan-version',
      artifactChecksum: 'checksum',
      revision: 3,
      approval: 'pending',
      lifecycle: 'awaiting_approval'
    } as never
    const commandInvoke = vi.fn(async (channel: string) => {
      if (channel === 'sessions:load-all') {
        return { sessions: [persisted], manifest: { version: 1 } }
      }
      if (channel === 'acp:get-plan-projection') return projection
      if (channel === 'acp:respond-plan') return { projection, changed: true }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({
      commands: commandsFrom(commandInvoke),
      agent: createAgent()
    })

    await expect(api.getSessionPlan(persisted.id)).resolves.toBe(projection)
    await expect(
      api.respondSessionPlan(persisted.id, {
        decision: 'approved',
        artifactVersionId: 'plan-version',
        expectedRevision: 3
      })
    ).resolves.toEqual({ projection, changed: true })

    expect(commandInvoke).toHaveBeenCalledWith('acp:get-plan-projection', expect.anything(), [
      project.id,
      persisted.id
    ])
    expect(commandInvoke).toHaveBeenCalledWith('acp:respond-plan', expect.anything(), [
      {
        projectId: project.id,
        sessionId: persisted.id,
        decision: 'approved',
        artifactVersionId: 'plan-version',
        expectedRevision: 3
      }
    ])
    await api.dispose()
  })
  it('exposes Task Run progress through one subscription seam', async () => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const ids = ['message-1', 'run-1', 'assistant-1']
    const agent = createAgent({
      prompt: vi.fn(async (_request, observer) => {
        observer?.onProviderPromptAccepted?.()
      })
    })
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id', now: () => 1 }
    )
    const phases: string[] = []
    const unsubscribe = api.subscribeProgress((event) => phases.push(event.phase))

    const run = await api.startRun({ project: project.id, prompt: 'Research this.' })
    await api.waitForRun(run.id)

    expect(phases).toEqual([
      'accepted',
      'session-ready',
      'prompt-dispatched',
      'provider-accepted',
      'completed'
    ])
    unsubscribe()
    await api.dispose()
  })

  it('exposes durable lifecycle state without hiding archived Sessions', async () => {
    const archivedSession: PersistedChatSession = {
      id: 'session-archived',
      projectId: project.id,
      title: 'Archived research',
      cwd: '/workspace/archived',
      status: 'idle',
      pinned: true,
      archivedAt: 30,
      messages: [],
      createdAt: 1,
      updatedAt: 30
    }
    const activeSession: PersistedChatSession = {
      id: 'session-active',
      projectId: project.id,
      title: 'Active research',
      cwd: '/workspace/active',
      status: 'idle',
      messages: [],
      createdAt: 2,
      updatedAt: 20
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        return { sessions: [archivedSession, activeSession], manifest: { version: 1 } }
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    try {
      await expect(api.listSessions(project.id)).resolves.toEqual([
        expect.objectContaining({ id: archivedSession.id, pinned: true, archivedAt: 30 }),
        expect.objectContaining({ id: activeSession.id, pinned: false, archivedAt: undefined })
      ])
      await expect(api.getSession(archivedSession.id)).resolves.toMatchObject({
        pinned: true,
        archivedAt: 30
      })
    } finally {
      await api.dispose()
    }
  })

  it.each([
    {
      name: 'Project',
      code: 'project_archived',
      projects: [{ ...project, archivedAt: 40 }],
      sessions: [] as PersistedChatSession[],
      request: { project: project.id, prompt: 'Research this.' },
      admissionMessage: 'Restore this archived Project before continuing.'
    },
    {
      name: 'Session',
      code: 'session_archived',
      projects: [project],
      sessions: [
        {
          id: 'session-archived',
          projectId: project.id,
          title: 'Archived research',
          cwd: '/workspace/archived',
          status: 'idle' as const,
          archivedAt: 40,
          messages: [],
          createdAt: 1,
          updatedAt: 40
        }
      ],
      request: {
        project: project.id,
        sessionId: 'session-archived',
        prompt: 'Continue this research.'
      },
      admissionMessage: 'Restore this archived Session before continuing.'
    }
  ])('reports archived $name admission as a stable Task conflict', async (fixture) => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return fixture.projects
        if (channel === 'sessions:load-all') {
          return { sessions: fixture.sessions, manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({
      commands: commandsFrom(invoke),
      agent: createAgent({
        withSessionAvailable: async () => {
          throw new Error(fixture.admissionMessage)
        }
      })
    })

    try {
      await expect(api.startRun(fixture.request)).rejects.toMatchObject({
        code: fixture.code,
        message: fixture.admissionMessage
      })
    } finally {
      await api.dispose()
    }
  })

  it('maps public query and artifact commands to the compatibility façade', async () => {
    const session: PersistedChatSession = {
      id: 'session-query',
      projectId: project.id,
      title: 'Query session',
      cwd: '/workspace/query',
      status: 'idle',
      messages: [],
      artifacts: [
        {
          id: 'artifact-query',
          kind: 'managed-file',
          path: '/artifacts/query.csv',
          name: 'query.csv',
          mimeType: 'text/csv',
          size: 12
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    const invoke = vi.fn(async (channel: string, _callerContext: unknown, args: unknown[]) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'projects:create') {
        return { ...project, ...(args[0] as object), id: 'project-created' }
      }
      if (channel === 'projects:update') {
        return { ...project, ...(args[0] as object), updatedAt: 3 }
      }
      if (channel === 'sessions:load-all') {
        return { sessions: [session], manifest: { version: 1 } }
      }
      if (channel === 'preview-resources:acquire') {
        return {
          id: 'resource-query',
          url: 'open-science-preview://resource-query/query.csv',
          size: 12,
          mimeType: 'text/csv'
        }
      }
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await expect(
      api.createProject({ name: 'Created', agentContext: 'Always cite sources.' })
    ).resolves.toMatchObject({
      id: 'project-created',
      name: 'Created',
      hasAgentContext: true
    })
    await expect(
      api.updateProject(project.id, {
        expectedUpdatedAt: project.updatedAt,
        agentContext: 'Prefer Python.'
      })
    ).resolves.toMatchObject({ id: project.id, updatedAt: 3, hasAgentContext: true })
    await expect(api.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ id: session.id, artifactCount: 1 })
    ])
    await expect(api.getSession(session.id)).resolves.toMatchObject({ title: session.title })
    await expect(api.listArtifacts(session.id)).resolves.toEqual(session.artifacts)
    await expect(api.acquireArtifact('artifact-query')).resolves.toMatchObject({
      resourceId: 'resource-query',
      name: 'query.csv'
    })
    await api.releaseArtifact('resource-query')

    expect(invoke).toHaveBeenCalledWith('preview-resources:acquire', taskCallerContext(), [
      {
        source: 'artifact',
        path: '/artifacts/query.csv',
        mimeType: 'text/csv'
      }
    ])
    expect(invoke).toHaveBeenCalledWith('preview-resources:release', taskCallerContext(), [
      { resourceId: 'resource-query' }
    ])
    expect(invoke).toHaveBeenCalledWith('projects:update', taskCallerContext(), [
      {
        id: project.id,
        expectedUpdatedAt: project.updatedAt,
        agentContext: 'Prefer Python.'
      }
    ])
  })

  it('uses the direct Agent port for an attached session and keeps artifact finalization on the façade', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const existing: PersistedChatSession = {
      id: 'session-attached',
      projectId: project.id,
      title: 'Attached session',
      cwd: '/workspace/attached',
      status: 'idle',
      permissionProfile: 'ask',
      memoryEnabled: false,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [existing], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      if (channel === 'artifacts:finalize-run') return { ok: true, artifacts: [] }
      throw new Error(`Unexpected Task command: ${channel} ${JSON.stringify(args)}`)
    })
    const agent = createAgent({
      listAttachedSessionIds: vi.fn(async () => [existing.id]),
      prompt: vi.fn(async (_request, observer) => {
        await observer?.onPromptAdmitted?.()
        emitEvent?.({
          id: 'artifact-event',
          timestamp: 10,
          kind: 'artifact',
          level: 'info',
          sessionId: existing.id,
          runId: 'attached-run',
          artifactClaimId: 'artifact-claim',
          artifacts: []
        })
      })
    })
    const ids = ['attached-user', 'attached-run', 'attached-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue research.',
      permissionProfile: 'auto'
    })
    await api.waitForRun(run.id)

    expect(agent.listAttachedSessionIds).toHaveBeenCalledOnce()
    expect(agent.setPermissionProfile).toHaveBeenCalledWith(existing.id, 'auto')
    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(existing.id, false)
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        provenanceContext: {
          rootFrameId: 'root-frame-session-attached',
          agentFrameId: 'root-frame-session-attached',
          messageBranchId: 'message-branch-session-attached',
          messageBranchAncestry: ['message-branch-session-attached'],
          messageAncestry: ['attached-user'],
          runtimeSegmentId: 'runtime-segment-session-attached',
          promptMessageId: 'attached-user'
        },
        text: 'Continue research.'
      },
      {
        onPromptAdmitted: expect.any(Function),
        onProviderPromptAccepted: expect.any(Function)
      }
    )
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
    expect(invoke).toHaveBeenCalledWith('artifacts:finalize-run', taskCallerContext(), [
      { claimId: 'artifact-claim', messageId: 'attached-agent' }
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:stage-task-completion', taskCallerContext(), [
      expect.objectContaining({
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        message: expect.objectContaining({ id: 'attached-agent' })
      })
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:settle-task-completion', taskCallerContext(), [
      expect.objectContaining({
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        messageId: 'attached-agent'
      })
    ])
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(
      expect.arrayContaining([
        'sessions:stage-task-completion',
        'artifacts:finalize-run',
        'sessions:settle-task-completion'
      ])
    )
    const terminalChannels = invoke.mock.calls.map(([channel]) => channel)
    expect(terminalChannels.indexOf('sessions:stage-task-completion')).toBeLessThan(
      terminalChannels.indexOf('artifacts:finalize-run')
    )
    expect(terminalChannels.indexOf('artifacts:finalize-run')).toBeLessThan(
      terminalChannels.indexOf('sessions:settle-task-completion')
    )
  })

  it('keeps deferred Session admission alive after remote authorization expires', async () => {
    const existing: PersistedChatSession = {
      id: 'session-admission-context',
      projectId: project.id,
      title: 'Admission context',
      cwd: '/workspace/admission-context',
      status: 'idle',
      permissionProfile: 'ask',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      if (!callerContext.isAuthorizationCurrent()) {
        throw new Error('Caller authorization is no longer current.')
      }
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        return { sessions: [existing], manifest: { version: 1 } }
      }
      if (channel === 'sessions:save-session') return args[0]
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const agent = createAgent({
      listAttachedSessionIds: vi.fn(async () => [existing.id]),
      prompt: vi.fn(async (_request, observer) => {
        authorizationCurrent = false
        await observer?.onPromptAdmitted?.()
        observer?.onProviderPromptAccepted?.()
      })
    })
    const ids = ['admission-user', 'admission-run', 'admission-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id' }
    )

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue after admission.'
      })
    )

    await expect(api.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' })
    expect(invoke).toHaveBeenCalledWith('sessions:save-session', taskCallerContext(), [
      expect.objectContaining({
        id: existing.id,
        status: 'running',
        activeRun: expect.objectContaining({ promptMessageId: 'admission-user' })
      })
    ])
    expect(authorizationCurrent).toBe(false)
    await api.dispose()
  })

  it('resumes a detached session through the direct Agent port with its durable binding', async () => {
    const existing: PersistedChatSession = {
      id: 'session-detached',
      projectId: project.id,
      title: 'Detached session',
      cwd: '/workspace/detached',
      status: 'idle',
      permissionProfile: 'ask',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:shared',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [existing], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      throw new Error(`Unexpected Task command: ${channel} ${JSON.stringify(args)}`)
    })
    const agent = createAgent({
      resumeSession: vi.fn(async () => ({ sessionId: existing.id, cwd: existing.cwd }))
    })
    const ids = ['detached-user', 'detached-run', 'detached-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id' }
    )

    const run = await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Resume research.'
    })
    await api.waitForRun(run.id)

    expect(agent.resumeSession).toHaveBeenCalledWith({
      sessionId: existing.id,
      cwd: existing.cwd,
      projectId: project.id,
      permissionProfile: 'ask',
      memoryEnabled: true,
      previousFrameworkId: 'codex',
      previousBackendId: 'codex:shared',
      previousModel: undefined,
      providerSessionId: undefined,
      providerContinuityToken: undefined
    })
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
  })

  it('uses the request caller before admission and the Task caller for admitted lifecycle work', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      void args
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const agent = createAgent({
      createSession: vi.fn(async () => ({
        sessionId: 'session-context',
        cwd: '/workspace/context'
      })),
      prompt: vi.fn(async () => promptGate)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({ project: project.id, prompt: 'Research with remote context.' })
    )
    authorizationCurrent = false
    finishPrompt?.()
    await api.waitForRun(run.id)

    expect(invoke).toHaveBeenCalledWith('projects:list', context, [])
    expect(invoke).toHaveBeenCalledWith('sessions:load-all', context, [])
    expect(invoke).toHaveBeenCalledWith('sessions:save-session', context, [
      expect.objectContaining({ status: 'running' })
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:settle-task-completion', taskCallerContext(), [
      expect.objectContaining({ sessionId: 'session-context' })
    ])
    expect(agent.createSession).toHaveBeenCalledWith({
      projectId: project.id,
      permissionProfile: 'ask'
    })
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: 'session-context',
        promptMessageId: expect.any(String),
        provenanceContext: {
          rootFrameId: 'root-frame-session-context',
          agentFrameId: 'root-frame-session-context',
          messageBranchId: 'message-branch-session-context',
          messageBranchAncestry: ['message-branch-session-context'],
          messageAncestry: [expect.any(String)],
          runtimeSegmentId: 'runtime-segment-session-context',
          promptMessageId: expect.any(String)
        },
        text: 'Research with remote context.'
      },
      { onProviderPromptAccepted: expect.any(Function) }
    )
    expect(context.isAuthorizationCurrent()).toBe(false)

    await api.runWithCallerContext(context, () => api.releaseArtifact('resource-context'))
    expect(invoke).toHaveBeenLastCalledWith(
      'preview-resources:release',
      expect.objectContaining({ location: 'local', actionOrigin: 'automation' }),
      [{ resourceId: 'resource-context' }]
    )
    expect(invoke.mock.calls.at(-1)?.[1].isAuthorizationCurrent()).toBe(true)
  })

  it('does not enter the direct Agent port after captured remote authorization expires', async () => {
    let authorizationCurrent = true
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        authorizationCurrent = false
        return { sessions: [], manifest: { version: 1 } }
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const agent = createAgent()
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })

    await expect(
      api.runWithCallerContext(context, () =>
        api.startRun({ project: project.id, prompt: 'Research after revocation.' })
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    expect(agent.listAttachedSessionIds).not.toHaveBeenCalled()
    expect(agent.createSession).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
  })

  it('forwards run cancellation through the direct Agent port under the request caller context', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-cancel-context' })),
      prompt: vi.fn(async () => promptGate),
      cancelPrompt: vi.fn(async () => finishPrompt?.())
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    const context = createTaskCallerContext({ location: 'remote' })

    const run = await api.startRun({ project: project.id, prompt: 'Cancel remotely.' })
    const cancelled = await api.runWithCallerContext(context, () => api.cancelRun(run.id))

    expect(cancelled).toMatchObject({ status: 'cancelled' })
    expect(agent.cancelPrompt).toHaveBeenCalledWith('session-cancel-context')
  })

  it('aborts the Reviewer command when cancellation reaches an automatic review', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') return { started: true }
        if (channel === 'reviewer:get-for-session') {
          return [{ id: 'review-1', turnMessageId: 'review-agent', lifecycle: 'running' }]
        }
        if (channel === 'reviewer:abort') return undefined
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-cancel' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'review-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-cancel',
          role: 'assistant',
          text: 'Review this output.'
        })
      })
    })
    const ids = ['review-user', 'review-run', 'review-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.startRun({
      project: project.id,
      prompt: 'Produce and review.',
      autoReviewEnabled: true
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviewer:get-for-session', expect.anything(), [
        { projectId: project.id, appSessionId: 'session-review-cancel' }
      ])
    )
    await expect(api.cancelRun(run.id)).resolves.toMatchObject({ status: 'cancelled' })

    expect(invoke).toHaveBeenCalledWith('reviewer:abort', expect.anything(), [
      { projectId: project.id, appSessionId: 'session-review-cancel' }
    ])
    await api.dispose()
  })

  it('keeps admitted automatic-review polling alive after remote authorization expires', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const invoke = vi.fn(
      async (channel: string, callerContext: CallerContext, args: unknown[]): Promise<unknown> => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return { sessions: [], manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') {
          expect(callerContext).toEqual(taskCallerContext())
          authorizationCurrent = false
          return { started: true }
        }
        if (channel === 'reviewer:get-for-session') {
          expect(callerContext).toEqual(taskCallerContext())
          expect(callerContext.isAuthorizationCurrent()).toBe(true)
          return [{ id: 'review-expired', turnMessageId: 'expired-agent', lifecycle: 'completed' }]
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-expired' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'expired-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-expired',
          role: 'assistant',
          text: 'Review after authorization expiry.'
        })
      })
    })
    const ids = ['expired-user', 'expired-run', 'expired-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({
        project: project.id,
        prompt: 'Produce and review after authorization expiry.',
        autoReviewEnabled: true
      })
    )
    await expect(api.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      review: { started: true, id: 'review-expired', lifecycle: 'completed' }
    })
    expect(authorizationCurrent).toBe(false)
    await api.dispose()
  })

  it('awaits Reviewer cleanup before completing Task API disposal', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markAbortStarted: (() => void) | undefined
    let releaseAbort: (() => void) | undefined
    const abortStarted = new Promise<void>((resolve) => {
      markAbortStarted = resolve
    })
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') return { started: true }
        if (channel === 'reviewer:get-for-session') {
          return [{ id: 'review-1', turnMessageId: 'dispose-agent', lifecycle: 'running' }]
        }
        if (channel === 'reviewer:abort') {
          markAbortStarted?.()
          await abortGate
          return undefined
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-dispose' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'dispose-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-dispose',
          role: 'assistant',
          text: 'Review before disposal.'
        })
      })
    })
    const ids = ['dispose-user', 'dispose-run', 'dispose-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    await api.startRun({
      project: project.id,
      prompt: 'Produce and review before disposal.',
      autoReviewEnabled: true
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviewer:get-for-session', expect.anything(), [
        { projectId: project.id, appSessionId: 'session-review-dispose' }
      ])
    )
    let disposed = false
    const disposal = api.dispose().then(() => {
      disposed = true
    })
    await abortStarted

    expect(disposed).toBe(false)
    releaseAbort?.()
    await disposal
    expect(disposed).toBe(true)
    expect(invoke).toHaveBeenCalledWith('reviewer:abort', expect.anything(), [
      { projectId: project.id, appSessionId: 'session-review-dispose' }
    ])
  })

  it('does not enter the direct Agent port for cancellation after authorization expires', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-revoked-cancel' })),
      prompt: vi.fn(async () => promptGate),
      cancelPrompt: vi.fn(async () => finishPrompt?.())
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    let authorizationCurrent = false
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const run = await api.startRun({ project: project.id, prompt: 'Keep running.' })

    await expect(api.runWithCallerContext(context, () => api.cancelRun(run.id))).rejects.toThrow(
      'Caller authorization is no longer current.'
    )
    expect(agent.cancelPrompt).not.toHaveBeenCalled()

    authorizationCurrent = true
    await api.runWithCallerContext(context, () => api.cancelRun(run.id))
  })
})
