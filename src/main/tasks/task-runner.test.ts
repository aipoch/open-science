import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { ARTIFACT_OWNERSHIP_PERSISTENCE_RACE } from '../../shared/artifacts'
import type { Project } from '../../shared/projects'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  TaskRunner,
  type TaskPreviewResourcePort,
  type TaskProjectPort,
  type TaskRunnerDependencies,
  type TaskSessionPort
} from './task-runner'

const project: Project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: project.id,
  title: 'Review session',
  cwd: '/workspace/review',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

const createRunner = (overrides: Partial<TaskRunnerDependencies> = {}): TaskRunner =>
  new TaskRunner({
    projects: {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    },
    sessions: { list: async () => [], save: async () => undefined },
    previewResources: {
      acquire: async () => ({ id: 'resource-1', url: 'preview://resource-1', size: 0 }),
      release: async () => undefined
    },
    agent: {
      withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
      listAttachedSessionIds: async () => [],
      createSession: async () => ({ sessionId: 'session-created' }),
      resumeSession: async (request) => ({ sessionId: request.sessionId }),
      setPermissionProfile: async () => undefined,
      cancelPrompt: async () => undefined,
      prompt: async () => undefined
    },
    artifacts: {
      finalizeRun: async () => ({ ok: true, artifacts: [] })
    },
    runtimeEvents: { subscribe: () => () => undefined },
    createId: () => 'generated-id',
    now: () => 1,
    ...overrides
  })

describe('TaskRunner', () => {
  it('lists projects through its public interface', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const runner = createRunner({ projects })

    await expect(runner.listProjects()).resolves.toEqual([project])
  })

  it('rejects an empty project name before creating a project', async () => {
    let created = false
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => {
        created = true
        return { ...project, ...request }
      }
    }
    const runner = createRunner({ projects })

    await expect(runner.createProject({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Project name is required.'
    })
    expect(created).toBe(false)
  })

  it('lists session snapshots for a project name', async () => {
    const projects: TaskProjectPort = {
      list: async () => [project],
      create: async (request) => ({ ...project, ...request })
    }
    const sessions: TaskSessionPort = {
      list: async () => [session],
      save: async () => undefined
    }
    const runner = createRunner({ projects, sessions })

    await expect(runner.listSessions(project.name)).resolves.toEqual([
      expect.objectContaining({ id: session.id, projectId: project.id, title: session.title })
    ])
  })

  it('returns a durable session snapshot and its artifacts', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined }
    })

    await expect(runner.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      artifactCount: 1
    })
    await expect(runner.listArtifacts(session.id)).resolves.toEqual(artifactSession.artifacts)
  })

  it('acquires and releases a persisted artifact through the preview-resource port', async () => {
    const artifactSession: PersistedChatSession = {
      ...session,
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'managed-file',
          path: '/artifacts/report.md',
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 12
        }
      ]
    }
    const released: string[] = []
    const previewResources: TaskPreviewResourcePort = {
      acquire: async () => ({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.md',
        size: 12,
        mimeType: 'text/markdown'
      }),
      release: async (resourceId) => {
        released.push(resourceId)
      }
    }
    const runner = createRunner({
      sessions: { list: async () => [artifactSession], save: async () => undefined },
      previewResources
    })

    await expect(runner.acquireArtifact('artifact-1')).resolves.toMatchObject({
      resourceId: 'resource-1',
      name: 'report.md',
      mimeType: 'text/markdown'
    })
    await runner.releaseArtifact('resource-1')
    expect(released).toEqual(['resource-1'])
  })

  it('rejects malformed run requests before crossing a port', async () => {
    let listedProjects = false
    const runner = createRunner({
      projects: {
        list: async () => {
          listedProjects = true
          return [project]
        },
        create: async (request) => ({ ...project, ...request })
      }
    })

    await expect(runner.startRun(null as never)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Run request must be an object.'
    })
    await expect(
      runner.startRun({
        project: project.id,
        prompt: 'Research',
        permissionProfile: 'unsafe' as never
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(listedProjects).toBe(false)
  })

  it('runs a prompt in a new durable session and returns the assistant output', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const ids = ['user-message-1', 'run-1', 'assistant-message-1']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({
          sessionId: 'session-1',
          cwd: '/workspace/session-1',
          frameworkId: 'codex',
          backendId: 'codex:shared'
        }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'event-1',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-1',
            role: 'assistant',
            text: 'Research complete.'
          })
          emitEvent?.({
            id: 'event-2',
            timestamp: 11,
            kind: 'stop',
            level: 'info',
            sessionId: 'session-1',
            text: 'end_turn',
            turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })

    const started = await runner.startRun({
      project: project.name,
      prompt: 'Review these papers.',
      permissionProfile: 'auto'
    })
    expect(started).toMatchObject({
      id: 'run-1',
      sessionId: 'session-1',
      projectId: project.id,
      status: 'running'
    })

    await expect(runner.waitForRun('run-1')).resolves.toMatchObject({
      status: 'completed',
      output: 'Research complete.'
    })
    expect(savedSessions.at(-1)).toMatchObject({
      id: 'session-1',
      projectId: project.id,
      status: 'idle',
      permissionProfile: 'auto',
      messages: [
        { id: 'user-message-1', role: 'user', content: 'Review these papers.' },
        {
          id: 'assistant-message-1',
          role: 'agent',
          content: 'Research complete.',
          turnUsage: { inputTokens: 31, cacheTokens: 15, outputTokens: 14 }
        }
      ]
    })
  })

  it('publishes ordered Run progress from acceptance through completion', async () => {
    const runner = createRunner()
    const progress: Array<{ phase: string; heartbeat: boolean }> = []
    const unsubscribe = runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat })
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
    await runner.waitForRun(started.id)

    expect(progress).toEqual([
      { phase: 'accepted', heartbeat: false },
      { phase: 'session-ready', heartbeat: false },
      { phase: 'prompt-dispatched', heartbeat: false },
      { phase: 'completed', heartbeat: false }
    ])

    unsubscribe()
    runner.dispose()
  })

  it('marks provider acceptance before the first visible provider event', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const phases: string[] = []
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request, observer) => {
          observer?.onProviderPromptAccepted?.()
          emitEvent?.({
            id: 'assistant-1',
            timestamp: 2,
            sessionId: request.sessionId,
            promptMessageId: request.promptMessageId,
            kind: 'message',
            role: 'assistant',
            level: 'info',
            text: 'Working on it.'
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => {
            emitEvent = undefined
          }
        }
      }
    })
    runner.subscribeProgress((event) => phases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
    await runner.waitForRun(started.id)

    expect(phases).toEqual([
      'accepted',
      'session-ready',
      'prompt-dispatched',
      'provider-accepted',
      'first-visible-output',
      'completed'
    ])
    runner.dispose()
  })

  it('emits liveness heartbeats until the first visible provider event', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let finishPrompt: (() => void) | undefined
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const progress: Array<{ phase: string; heartbeat: boolean; elapsedMs: number }> = []
    const runner = createRunner({
      now: Date.now,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => prompt
      }
    })
    runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat, elapsedMs: event.elapsedMs })
    })

    try {
      const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(progress.at(-1)).toEqual({
        phase: 'prompt-dispatched',
        heartbeat: true,
        elapsedMs: 10_000
      })

      finishPrompt?.()
      await runner.waitForRun(started.id)
      const countAfterCompletion = progress.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(progress).toHaveLength(countAfterCompletion)
    } finally {
      runner.dispose()
      vi.useRealTimers()
    }
  })

  it('keeps Run execution independent from progress subscriber failures', async () => {
    const runner = createRunner()
    runner.subscribeProgress(() => {
      throw new Error('subscriber failed')
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })

    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({ status: 'completed' })
    runner.dispose()
  })

  it('stops liveness heartbeats after the first visible provider event', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let acceptProvider: (() => void) | undefined
    let finishPrompt: (() => void) | undefined
    const prompt = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const progress: Array<{ phase: string; heartbeat: boolean }> = []
    const runner = createRunner({
      now: Date.now,
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-1' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (_request, observer) => {
          acceptProvider = observer?.onProviderPromptAccepted
          return prompt
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => {
            emitEvent = undefined
          }
        }
      }
    })
    runner.subscribeProgress((event) => {
      progress.push({ phase: event.phase, heartbeat: event.heartbeat })
    })

    try {
      const started = await runner.startRun({ project: project.id, prompt: 'Research this.' })
      acceptProvider?.()
      emitEvent?.({
        id: 'other-prompt-assistant',
        timestamp: 2,
        sessionId: 'session-1',
        promptMessageId: 'other-prompt',
        kind: 'message',
        role: 'assistant',
        level: 'info',
        text: 'Unrelated side-chat output.'
      })
      expect(progress.at(-1)).toEqual({ phase: 'provider-accepted', heartbeat: false })
      emitEvent?.({
        id: 'provider-warning',
        timestamp: 3,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'system',
        level: 'warning',
        text: 'Provider is retrying.'
      })
      emitEvent?.({
        id: 'terminal-stop',
        timestamp: 4,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'stop',
        level: 'info',
        title: 'Prompt stopped',
        text: 'end_turn'
      })
      expect(progress.at(-1)).toEqual({ phase: 'provider-accepted', heartbeat: false })
      emitEvent?.({
        id: 'assistant-1',
        timestamp: 5,
        sessionId: 'session-1',
        promptMessageId: 'generated-id',
        kind: 'message',
        role: 'assistant',
        level: 'info',
        text: 'Working on it.'
      })
      const countAfterFirstOutput = progress.length

      await vi.advanceTimersByTimeAsync(20_000)
      expect(progress).toHaveLength(countAfterFirstOutput)
      expect(progress.slice(-2)).toEqual([
        { phase: 'provider-accepted', heartbeat: false },
        { phase: 'first-visible-output', heartbeat: false }
      ])

      finishPrompt?.()
      const completed = await runner.waitForRun(started.id)
      expect(completed.output).toBe('Working on it.')
    } finally {
      runner.dispose()
      vi.useRealTimers()
    }
  })

  it('rejects overlapping runs for the same durable session', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const existing: PersistedChatSession = {
      ...session,
      id: 'session-busy',
      cwd: '/workspace/session-busy'
    }
    const ids = ['first-user', 'first-run', 'second-user', 'second-run', 'assistant-message']
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => promptGate
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const first = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'First prompt'
    })

    try {
      await expect(
        runner.startRun({
          project: project.id,
          sessionId: existing.id,
          prompt: 'Overlapping prompt'
        })
      ).rejects.toMatchObject({
        code: 'session_busy',
        message: `Session already has an active run: ${existing.id}`
      })
    } finally {
      finishPrompt?.()
      await runner.waitForRun(first.id)
    }
  })

  it('checks archive admission before an existing session is resumed or saved', async () => {
    const existing = { ...session, id: 'session-archived' }
    const resumeSession = async (): Promise<never> => {
      throw new Error('must not resume')
    }
    const save = async (): Promise<never> => {
      throw new Error('must not save')
    }
    const runner = createRunner({
      sessions: { list: async () => [existing], save },
      agent: {
        withSessionAvailable: async () => {
          throw new Error('Restore this archived Session before continuing.')
        },
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession,
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      }
    })

    await expect(
      runner.startRun({ project: project.id, sessionId: existing.id, prompt: 'Resume research.' })
    ).rejects.toThrow('Restore this archived Session before continuing.')
  })

  it('resumes a detached session without duplicating the new prompt in history replay', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'old-user',
          role: 'user',
          content: 'Initial question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'old-agent',
          role: 'agent',
          content: 'Initial answer',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    let admissionActive = false
    let saveCount = 0
    const resumeRequests: Parameters<TaskRunnerDependencies['agent']['resumeSession']>[0][] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'run-2', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async () => {
          saveCount += 1
          if (saveCount === 1) expect(admissionActive).toBe(true)
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => {
          admissionActive = true
          try {
            return await operation()
          } finally {
            admissionActive = false
          }
        },
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => {
          expect(admissionActive).toBe(true)
          resumeRequests.push(request)
          return { sessionId: existing.id, cwd: existing.cwd, contextReset: true }
        },
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Follow-up question',
      permissionProfile: 'auto'
    })
    await runner.waitForRun(started.id)
    expect(admissionActive).toBe(false)
    expect(saveCount).toBeGreaterThanOrEqual(1)

    expect(resumeRequests).toEqual([
      expect.objectContaining({ sessionId: existing.id, permissionProfile: 'auto' })
    ])
    expect(prompts).toEqual([
      {
        sessionId: existing.id,
        promptMessageId: 'new-user',
        text: 'Follow-up question',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Initial question\n\nAssistant: Initial answer'
      }
    ])
  })

  it('starts a new run without replaying an interrupted task prompt or retaining recovery state', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Collect the papers',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'Collected 20 papers',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'interrupted-user',
          role: 'user',
          content: 'Delete the duplicates',
          status: 'complete',
          interrupted: true,
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'interrupted-user'
      },
      pendingHistoryReplay: { kind: 'before-message', messageId: 'interrupted-user' },
      error: 'Session was interrupted before the app closed.'
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({
          sessionId: existing.id,
          cwd: existing.cwd,
          contextReset: true
        }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue with a different cleanup rule.'
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      expect.objectContaining({
        text: 'Continue with a different cleanup rule.',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Collect the papers\n\nAssistant: Collected 20 papers'
      })
    ])
    expect(prompts[0]?.historyPreamble).not.toContain('Delete the duplicates')
    expect(saved[0]).not.toHaveProperty('resumeRecovery')
    expect(saved[0].pendingHistoryReplay).toEqual({
      kind: 'before-message',
      messageId: 'interrupted-user'
    })
    expect(saved.at(-1)).not.toHaveProperty('pendingHistoryReplay')
    expect(
      saved[0]?.messages.filter((message) => message.content === 'Delete the duplicates')
    ).toHaveLength(1)
  })

  it('replays and consumes full-history recovery for an attached task session', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Summarize the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'The evidence is mixed.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      pendingHistoryReplay: { kind: 'all' }
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({ sessionId: 'unused' }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Compare the evidence groups.'
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      expect.objectContaining({
        text: 'Compare the evidence groups.',
        contextReset: true,
        historyPreamble:
          'Previous conversation:\n\nUser: Summarize the evidence\n\nAssistant: The evidence is mixed.'
      })
    ])
    expect(saved[0].pendingHistoryReplay).toEqual({ kind: 'all' })
    expect(saved.at(-1)).not.toHaveProperty('pendingHistoryReplay')
  })

  it('retains full-history replay when the task prompt is rejected before acceptance', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Summarize the evidence',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'The evidence is mixed.',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      pendingHistoryReplay: { kind: 'all' }
    }
    const saved: PersistedChatSession[] = []
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['new-user', 'new-run', 'new-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [existing],
        save: async (value) => {
          saved.push(structuredClone(value))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async () => ({ sessionId: 'unused' }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
          throw new Error('provider rejected prompt')
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Compare the evidence groups.'
    })
    const completed = await runner.waitForRun(started.id)

    expect(completed.status).toBe('failed')
    expect(prompts[0]).toMatchObject({
      contextReset: true,
      historyPreamble:
        'Previous conversation:\n\nUser: Summarize the evidence\n\nAssistant: The evidence is mixed.'
    })
    expect(saved[0].pendingHistoryReplay).toEqual({ kind: 'all' })
    expect(saved.at(-1)?.pendingHistoryReplay).toEqual({ kind: 'all' })
  })

  it('provides transcript fallback for skill-triggered reconnects', async () => {
    const existing: PersistedChatSession = {
      ...session,
      messages: [
        {
          id: 'prior-user',
          role: 'user',
          content: 'Prior question',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'prior-agent',
          role: 'agent',
          content: 'Prior answer',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    const prompts: Parameters<TaskRunnerDependencies['agent']['prompt']>[0][] = []
    const ids = ['skill-user', 'skill-run', 'skill-agent']
    const runner = createRunner({
      sessions: { list: async () => [existing], save: async () => undefined },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [existing.id],
        createSession: async () => ({ sessionId: 'unused' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async (request) => {
          prompts.push(request)
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Use the selected skill.',
      skillIds: ['literature-review']
    })
    await runner.waitForRun(started.id)

    expect(prompts).toEqual([
      {
        sessionId: existing.id,
        promptMessageId: 'skill-user',
        text: 'Use the selected skill.',
        skillIds: ['literature-review'],
        resumeFallback: {
          historyPreamble:
            'Previous conversation:\n\nUser: Prior question\n\nAssistant: Prior answer'
        }
      }
    ])
  })

  it('marks artifact-only completions when turn usage is unavailable', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const ids = ['artifact-user', 'artifact-run', 'artifact-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-artifact', cwd: '/workspace/artifact' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'artifact-event',
            timestamp: 10,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-artifact',
            artifactClaimId: 'artifact-claim',
            artifacts: []
          })
          emitEvent?.({
            id: 'artifact-stop',
            timestamp: 11,
            kind: 'stop',
            level: 'info',
            sessionId: 'session-artifact',
            text: 'end_turn'
          })
        }
      },
      artifacts: {
        finalizeRun: async () => ({
          ok: true,
          artifacts: [
            {
              id: 'artifact-file',
              projectName: project.id,
              sessionId: 'session-artifact',
              messageId: 'artifact-agent',
              name: 'result.txt',
              path: '/artifacts/result.txt',
              fileUrl: 'open-science-preview://artifact-file/result.txt',
              mimeType: 'text/plain',
              size: 6,
              mtimeMs: 11
            }
          ]
        })
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create a file.' })
    const completed = await runner.waitForRun(started.id)

    expect(completed).toMatchObject({
      status: 'completed',
      artifacts: [{ id: 'artifact-file', name: 'result.txt' }]
    })
    expect(savedSessions.at(-1)?.messages.at(-1)).toMatchObject({
      id: 'artifact-agent',
      role: 'agent',
      content: '',
      turnUsageUnavailable: true,
      artifactIds: ['artifact-file']
    })
  })

  it('settles a run as failed when final session persistence fails', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let saveCount = 0
    const ids = ['save-user', 'save-run', 'save-agent']
    const progressPhases: string[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => {
          saveCount += 1
          if (saveCount === 2) throw new Error('Session storage is unavailable')
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-save', cwd: '/workspace/save' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'save-event',
            timestamp: 10,
            kind: 'message',
            level: 'info',
            sessionId: 'session-save',
            role: 'assistant',
            text: 'Unsaved answer'
          })
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })
    runner.subscribeProgress((event) => progressPhases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Produce an answer.' })

    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Session storage is unavailable',
      output: 'Unsaved answer',
      completedAt: 100
    })
    expect(saveCount).toBe(3)
    expect(progressPhases.at(-1)).toBe('failed')
  })

  it('preserves finalized artifacts when a later claim fails after an ownership retry', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finalizeAttempts = 0
    const savedSessions: PersistedChatSession[] = []
    const ids = ['partial-user', 'partial-run', 'partial-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-partial', cwd: '/workspace/partial' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'artifact-first',
            timestamp: 10,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-partial',
            artifactClaimId: 'claim-1',
            artifacts: []
          })
          emitEvent?.({
            id: 'artifact-second',
            timestamp: 11,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-partial',
            artifactClaimId: 'claim-2',
            artifacts: []
          })
          emitEvent?.({
            id: 'provider-error',
            timestamp: 12,
            kind: 'error',
            level: 'error',
            sessionId: 'session-partial',
            text: 'Provider rejected the request.'
          })
          throw new Error('raw provider failure')
        }
      },
      artifacts: {
        finalizeRun: async (request) => {
          finalizeAttempts += 1
          if (request.claimId === 'claim-1' && finalizeAttempts === 1) {
            return {
              ok: false,
              code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
              message: 'The durable projection has not caught up yet.'
            }
          }
          if (request.claimId === 'claim-2') {
            throw new Error('compatibility publication failed')
          }
          return {
            ok: true,
            artifacts: [
              {
                id: 'artifact-partial',
                projectName: project.id,
                sessionId: 'session-partial',
                messageId: 'partial-agent',
                name: 'partial-report.md',
                path: '/artifacts/partial-report.md',
                fileUrl: 'open-science-preview://artifact-partial/partial-report.md',
                mimeType: 'text/markdown',
                size: 10,
                mtimeMs: 12
              }
            ]
          }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id'
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create a report.' })
    const failed = await runner.waitForRun(started.id)

    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-partial', name: 'partial-report.md' }]
    })
    expect(finalizeAttempts).toBe(3)
    expect(savedSessions.at(-1)).toMatchObject({
      status: 'error',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-partial', name: 'partial-report.md' }]
    })
  })

  it('persists terminal tool activity and provider failure reportability', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const ids = ['tool-user', 'tool-run', 'tool-agent']
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-tool', cwd: '/workspace/tool' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'tool-start',
            timestamp: 10,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            title: 'Run analysis',
            status: 'in_progress',
            providerToolName: 'shell'
          })
          emitEvent?.({
            id: 'tool-complete',
            timestamp: 11,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            status: 'completed',
            terminalOutput: 'done\n',
            terminalExitCode: 0
          })
          emitEvent?.({
            id: 'tool-metadata',
            timestamp: 12,
            kind: 'tool',
            level: 'info',
            sessionId: 'session-tool',
            toolCallId: 'tool-call-1',
            rawOutput: { stdout: 'done' }
          })
          emitEvent?.({
            id: 'provider-error',
            timestamp: 13,
            kind: 'error',
            level: 'error',
            sessionId: 'session-tool',
            text: 'Provider quota exceeded.',
            providerError: true
          })
          throw new Error('opaque provider error')
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: () => ids.shift() ?? 'generated-id',
      now: () => 100
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Run analysis.' })
    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'Provider quota exceeded.'
    })
    expect(savedSessions.at(-1)).toMatchObject({
      status: 'error',
      error: 'Provider quota exceeded.',
      errorReportable: false,
      activities: [
        {
          id: 'tool-call-1',
          title: 'Run analysis',
          status: 'completed',
          eventIds: ['tool-start', 'tool-complete', 'tool-metadata'],
          rawOutput: { stdout: 'done' },
          terminalOutput: 'done\n',
          terminalExitCode: 0,
          createdAt: 10,
          updatedAt: 11
        }
      ]
    })
  })

  it('cancels one active run, retains partial output, and returns the Session to idle', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let rejectPrompt: ((error: Error) => void) | undefined
    const promptGate = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject
    })
    const savedSessions: PersistedChatSession[] = []
    const cancelPrompt = vi.fn(async (sessionId: string) => {
      emitEvent?.({
        id: 'partial-output',
        timestamp: 20,
        kind: 'message',
        level: 'info',
        sessionId,
        role: 'assistant',
        text: 'Partial result.'
      })
      rejectPrompt?.(new Error('provider prompt cancelled'))
    })
    let time = 100
    const progressPhases: string[] = []
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async (saved) => {
          savedSessions.push(structuredClone(saved))
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => promptGate,
        cancelPrompt
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['cancel-user', 'cancel-run', 'cancel-agent']
        return () => ids.shift() ?? 'generated-id'
      })(),
      now: () => ++time
    })
    runner.subscribeProgress((event) => progressPhases.push(event.phase))

    const started = await runner.startRun({ project: project.id, prompt: 'Long research.' })
    const cancelled = await runner.cancelRun(started.id)

    expect(cancelPrompt).toHaveBeenCalledOnce()
    expect(cancelPrompt).toHaveBeenCalledWith('session-cancel')
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      output: 'Partial result.',
      cancelRequestedAt: expect.any(Number),
      cancelledAt: expect.any(Number),
      completedAt: expect.any(Number)
    })
    expect(cancelled.cancelledAt).toBe(cancelled.completedAt)
    expect(progressPhases.at(-1)).toBe('cancelled')
    expect(savedSessions.at(-1)).toMatchObject({
      id: 'session-cancel',
      status: 'idle',
      activeRun: undefined,
      messages: [
        expect.objectContaining({ role: 'user', content: 'Long research.' }),
        expect.objectContaining({ role: 'agent', content: 'Partial result.' })
      ]
    })
  })

  it('deduplicates concurrent cancellation and treats terminal cancellation as a read', async () => {
    let finishPrompt: (() => void) | undefined
    let acceptCancellation: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const cancellationGate = new Promise<void>((resolve) => {
      acceptCancellation = resolve
    })
    const cancelPrompt = vi.fn(async () => {
      await cancellationGate
      finishPrompt?.()
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-concurrent-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => promptGate,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['concurrent-user', 'concurrent-run', 'concurrent-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Cancel once.' })
    const first = runner.cancelRun(started.id)
    const second = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    acceptCancellation?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      expect.objectContaining({ status: 'cancelled' })
    ])
    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelPrompt).toHaveBeenCalledOnce()
  })

  it('leaves a naturally terminal run unchanged when cancellation arrives late', async () => {
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-completed' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => undefined,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['completed-user', 'completed-run', 'completed-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Finish naturally.' })
    await runner.waitForRun(started.id)

    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({
      status: 'completed',
      cancelRequestedAt: undefined,
      cancelledAt: undefined
    })
    expect(cancelPrompt).not.toHaveBeenCalled()
  })

  it('observes cancellation accepted while the final Session save is draining', async () => {
    let finalSaveStarted: (() => void) | undefined
    let releaseFinalSave: (() => void) | undefined
    const finalSaveStart = new Promise<void>((resolve) => {
      finalSaveStarted = resolve
    })
    const finalSaveGate = new Promise<void>((resolve) => {
      releaseFinalSave = resolve
    })
    let saveCount = 0
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      sessions: {
        list: async () => [],
        save: async () => {
          saveCount += 1
          if (saveCount === 2) {
            finalSaveStarted?.()
            await finalSaveGate
          }
        }
      },
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-during-save' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => undefined,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['save-user', 'save-run', 'save-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Finish and persist.' })
    await finalSaveStart
    const cancellation = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    releaseFinalSave?.()

    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('keeps a real Prompt failure when cancellation is requested afterward', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finalizationStarted: (() => void) | undefined
    let releaseFinalization: (() => void) | undefined
    const finalizationStart = new Promise<void>((resolve) => {
      finalizationStarted = resolve
    })
    const finalizationGate = new Promise<void>((resolve) => {
      releaseFinalization = resolve
    })
    const cancelPrompt = vi.fn(async () => undefined)
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-failure-before-cancel' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'failure-artifact',
            timestamp: 20,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-failure-before-cancel',
            artifactClaimId: 'claim-failure-before-cancel',
            artifacts: []
          })
          throw new Error('provider failed before cancellation')
        },
        cancelPrompt
      },
      artifacts: {
        finalizeRun: async () => {
          finalizationStarted?.()
          await finalizationGate
          return { ok: true, artifacts: [] }
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['failure-user', 'failure-run', 'failure-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Fail first.' })
    await finalizationStart
    const cancellation = runner.cancelRun(started.id)
    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledOnce())
    releaseFinalization?.()

    await expect(cancellation).resolves.toMatchObject({
      status: 'failed',
      error: 'provider failed before cancellation'
    })
  })

  it('clears a rejected cancellation request while the run remains active', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const cancelPrompt = vi.fn(async () => {
      throw new Error('cancel dispatch failed')
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-failure' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => promptGate,
        cancelPrompt
      },
      createId: (() => {
        const ids = ['failure-user', 'failure-run', 'failure-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Keep working.' })
    await expect(runner.cancelRun(started.id)).rejects.toThrow('cancel dispatch failed')
    expect(runner.getRun(started.id)).toMatchObject({
      status: 'running',
      cancelRequestedAt: undefined
    })

    finishPrompt?.()
    await expect(runner.waitForRun(started.id)).resolves.toMatchObject({ status: 'completed' })
  })

  it('lets Artifact finalization failure win after cancellation is accepted', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: 'session-cancel-artifact' }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        prompt: async () => {
          emitEvent?.({
            id: 'cancel-artifact',
            timestamp: 20,
            kind: 'artifact',
            level: 'info',
            sessionId: 'session-cancel-artifact',
            artifactClaimId: 'claim-cancel-artifact',
            artifacts: []
          })
          return promptGate
        },
        cancelPrompt: async () => finishPrompt?.()
      },
      artifacts: {
        finalizeRun: async () => {
          throw new Error('artifact finalization failed')
        }
      },
      runtimeEvents: {
        subscribe: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      },
      createId: (() => {
        const ids = ['artifact-user', 'artifact-run', 'artifact-agent']
        return () => ids.shift() ?? 'generated-id'
      })()
    })

    const started = await runner.startRun({ project: project.id, prompt: 'Create then cancel.' })

    await expect(runner.cancelRun(started.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'artifact finalization failed'
    })
  })

  it('releases its runtime-event subscription when disposed', () => {
    let unsubscribeCount = 0
    const runner = createRunner({
      runtimeEvents: {
        subscribe: () => () => {
          unsubscribeCount += 1
        }
      }
    })

    runner.dispose()

    expect(unsubscribeCount).toBe(1)
  })

  it('retains at most 200 terminal runs while preserving current snapshots', async () => {
    let idCounter = 0
    let sessionCounter = 0
    let time = 0
    const runner = createRunner({
      agent: {
        withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
        listAttachedSessionIds: async () => [],
        createSession: async () => ({ sessionId: `session-${++sessionCounter}` }),
        resumeSession: async (request) => ({ sessionId: request.sessionId }),
        setPermissionProfile: async () => undefined,
        cancelPrompt: async () => undefined,
        prompt: async () => undefined
      },
      createId: () => `id-${++idCounter}`,
      now: () => ++time
    })
    let firstRunId = ''
    let latestRunId = ''

    for (let index = 0; index < 201; index += 1) {
      const started = await runner.startRun({
        project: project.id,
        prompt: `Research request ${index}`
      })
      if (index === 0) firstRunId = started.id
      latestRunId = started.id
      await runner.waitForRun(started.id)
    }

    expect(() => runner.getRun(firstRunId)).toThrow(
      expect.objectContaining({ code: 'run_not_found' })
    )
    expect(runner.getRun(latestRunId)).toMatchObject({ status: 'completed' })
  })
})
