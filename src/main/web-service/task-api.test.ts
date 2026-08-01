import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
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

describe('HeadlessTaskApi adapter', () => {
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
    const api = new HeadlessTaskApi({ invoke })

    await expect(api.createProject({ name: 'Created' })).resolves.toMatchObject({
      id: 'project-created',
      name: 'Created'
    })
    await expect(api.listSessions(project.name)).resolves.toEqual([
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
  })

  it('maps attached-session and artifact-finalization ports to façade channels', async () => {
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
      if (channel === 'acp:get-state') return { sessionIds: [existing.id] }
      if (channel === 'acp:set-permission-profile') return undefined
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'acp:send-prompt') {
        emitEvent?.({
          id: 'artifact-event',
          timestamp: 10,
          kind: 'artifact',
          level: 'info',
          sessionId: existing.id,
          artifactClaimId: 'artifact-claim',
          artifacts: []
        })
        return undefined
      }
      if (channel === 'artifacts:finalize-run') return { ok: true, artifacts: [] }
      throw new Error(`Unexpected RPC channel: ${channel} ${JSON.stringify(args)}`)
    })
    const ids = ['attached-user', 'attached-run', 'attached-agent']
    const api = new HeadlessTaskApi(
      { invoke },
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

    expect(invoke).toHaveBeenCalledWith('acp:get-state', taskCallerContext(), [])
    expect(invoke).toHaveBeenCalledWith('acp:set-permission-profile', taskCallerContext(), [
      { sessionId: existing.id, profile: 'auto' }
    ])
    expect(invoke).toHaveBeenCalledWith('artifacts:finalize-run', taskCallerContext(), [
      { claimId: 'artifact-claim', messageId: 'attached-agent' }
    ])
  })

  it('maps detached-session resume to the façade with its durable Agent binding', async () => {
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
      if (channel === 'acp:get-state') return { sessionIds: [] }
      if (channel === 'acp:resume-session') {
        return { sessionId: existing.id, cwd: existing.cwd }
      }
      if (channel === 'sessions:save-session' || channel === 'acp:send-prompt') return undefined
      throw new Error(`Unexpected RPC channel: ${channel} ${JSON.stringify(args)}`)
    })
    const ids = ['detached-user', 'detached-run', 'detached-agent']
    const api = new HeadlessTaskApi({ invoke }, { createId: () => ids.shift() ?? 'generated-id' })

    const run = await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Resume research.'
    })
    await api.waitForRun(run.id)

    expect(invoke).toHaveBeenCalledWith('acp:resume-session', taskCallerContext(), [
      {
        sessionId: existing.id,
        cwd: existing.cwd,
        projectName: project.id,
        permissionProfile: 'ask',
        previousFrameworkId: 'codex',
        previousBackendId: 'codex:shared'
      }
    ])
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
      if (channel === 'acp:create-session') {
        return { sessionId: 'session-context', cwd: '/workspace/context' }
      }
      if (channel === 'acp:send-prompt') return promptGate
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
    const api = new HeadlessTaskApi({ invoke })
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
    expect(context.isAuthorizationCurrent()).toBe(false)

    await api.runWithCallerContext(context, () => api.releaseArtifact('resource-context'))
    expect(invoke).toHaveBeenLastCalledWith(
      'preview-resources:release',
      expect.objectContaining({ location: 'local', actionOrigin: 'automation' }),
      [{ resourceId: 'resource-context' }]
    )
    expect(invoke.mock.calls.at(-1)?.[1].isAuthorizationCurrent()).toBe(true)
  })
})
