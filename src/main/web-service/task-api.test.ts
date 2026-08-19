import { describe, expect, it, vi, type MockedFunction } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import type { TaskAgentPort } from '../tasks/task-runner'
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
  prompt: vi.fn<TaskAgentPort['prompt']>(async () => undefined),
  cancelPrompt: vi.fn<TaskAgentPort['cancelPrompt']>(async () => undefined),
  ...overrides
})

const commandsFrom = (
  invoke: (channel: string, callerContext: CallerContext, args: unknown[]) => Promise<unknown>
): ApplicationCommandByNameDispatcher => ({
  commandNames: () => [],
  invoke: (channel, invocation) => invoke(channel, invocation.callerContext, [...invocation.args])
})

describe('HeadlessTaskApi adapter', () => {
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
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      throw new Error(`Unexpected Task command: ${channel}`)
    })
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
      throw new Error(`Unexpected RPC channel: ${channel}`)
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
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [existing], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'artifacts:finalize-run') return { ok: true, artifacts: [] }
      throw new Error(`Unexpected RPC channel: ${channel} ${JSON.stringify(args)}`)
    })
    const agent = createAgent({
      listAttachedSessionIds: vi.fn(async () => [existing.id]),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'artifact-event',
          timestamp: 10,
          kind: 'artifact',
          level: 'info',
          sessionId: existing.id,
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
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        text: 'Continue research.'
      },
      { onProviderPromptAccepted: expect.any(Function) }
    )
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
    expect(invoke).toHaveBeenCalledWith('artifacts:finalize-run', taskCallerContext(), [
      { claimId: 'artifact-claim', messageId: 'attached-agent' }
    ])
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
      if (channel === 'sessions:save-session') return undefined
      throw new Error(`Unexpected RPC channel: ${channel} ${JSON.stringify(args)}`)
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
      previousFrameworkId: 'codex',
      previousBackendId: 'codex:shared'
    })
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
  })

  it('keeps the captured request caller across asynchronous run façade calls', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      void args
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected RPC channel: ${channel}`)
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

    expect(invoke).toHaveBeenCalled()
    expect(invoke.mock.calls.every(([, callerContext]) => callerContext === context)).toBe(true)
    expect(agent.createSession).toHaveBeenCalledWith({
      projectId: project.id,
      permissionProfile: 'ask'
    })
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: 'session-context',
        promptMessageId: expect.any(String),
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
      throw new Error(`Unexpected RPC channel: ${channel}`)
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
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
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
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'reviewer:run') return { started: true }
      if (channel === 'reviewer:get-for-session') {
        return [{ id: 'review-1', turnMessageId: 'review-agent', lifecycle: 'running' }]
      }
      if (channel === 'reviewer:abort') return undefined
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
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
      async (channel: string, callerContext: CallerContext): Promise<unknown> => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return { sessions: [], manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') return undefined
        if (channel === 'reviewer:run') {
          expect(callerContext).toBe(context)
          authorizationCurrent = false
          return { started: true }
        }
        if (channel === 'reviewer:get-for-session') {
          expect(callerContext).toEqual(taskCallerContext())
          expect(callerContext.isAuthorizationCurrent()).toBe(true)
          return [{ id: 'review-expired', turnMessageId: 'expired-agent', lifecycle: 'completed' }]
        }
        throw new Error(`Unexpected RPC channel: ${channel}`)
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
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'reviewer:run') return { started: true }
      if (channel === 'reviewer:get-for-session') {
        return [{ id: 'review-1', turnMessageId: 'dispose-agent', lifecycle: 'running' }]
      }
      if (channel === 'reviewer:abort') {
        markAbortStarted?.()
        await abortGate
        return undefined
      }
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
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
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return undefined
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
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
