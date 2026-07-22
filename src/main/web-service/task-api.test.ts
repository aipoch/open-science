import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { HeadlessTaskApi } from './task-api'

const project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

describe('HeadlessTaskApi', () => {
  it('rejects malformed public run requests before invoking internal RPC', async () => {
    const invoke = vi.fn()
    const api = new HeadlessTaskApi({ invoke })

    await expect(api.startRun(null as never)).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Run request must be an object.'
    })
    await expect(
      api.startRun({
        project: project.id,
        prompt: 'Research',
        permissionProfile: 'unsafe' as never
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('runs a prompt in a new durable session and returns the assistant output', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const invoke = vi.fn(async (channel: string, _clientId: string, args: unknown[]) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'acp:create-session') {
        return {
          sessionId: 'session-1',
          cwd: '/workspace/session-1',
          frameworkId: 'codex',
          backendId: 'codex:shared'
        }
      }
      if (channel === 'sessions:save-session') {
        savedSessions.push(structuredClone(args[0]) as PersistedChatSession)
        return undefined
      }
      if (channel === 'acp:send-prompt') {
        emitEvent?.({
          id: 'event-1',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-1',
          messageId: 'assistant-1',
          role: 'assistant',
          text: 'Research complete.'
        })
        emitEvent?.({
          id: 'event-2',
          timestamp: 11,
          kind: 'stop',
          level: 'info',
          sessionId: 'session-1',
          text: 'end_turn'
        })
        return {}
      }
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
    const api = new HeadlessTaskApi(
      { invoke },
      {
        createId: (() => {
          const ids = ['user-message-1', 'run-1']
          return () => ids.shift() ?? 'generated-id'
        })(),
        now: () => 100,
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const started = await api.startRun({
      project: 'systematic-review',
      prompt: 'Review these papers.',
      permissionProfile: 'auto'
    })
    expect(started).toMatchObject({
      id: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      status: 'running'
    })

    const completed = await api.waitForRun('run-1')
    expect(completed).toMatchObject({
      status: 'completed',
      output: 'Research complete.'
    })
    expect(savedSessions.at(-1)).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      status: 'idle',
      permissionProfile: 'auto',
      messages: [
        { id: 'user-message-1', role: 'user', content: 'Review these papers.' },
        { role: 'agent', content: 'Research complete.', status: 'complete' }
      ]
    })
    expect(invoke).toHaveBeenCalledWith('acp:send-prompt', expect.any(String), [
      { sessionId: 'session-1', text: 'Review these papers.' }
    ])
  })

  it('resumes a durable session without duplicating the new prompt in history replay', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const existing: PersistedChatSession = {
      id: 'session-1',
      projectId: project.id,
      title: 'Prior work',
      cwd: '/workspace/session-1',
      status: 'idle',
      permissionProfile: 'ask',
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
      ],
      createdAt: 1,
      updatedAt: 2
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        return { sessions: [existing], manifest: { version: 1 } }
      }
      if (channel === 'acp:get-state') return { sessionIds: [] }
      if (channel === 'acp:resume-session') {
        return { sessionId: existing.id, cwd: existing.cwd, contextReset: true }
      }
      if (channel === 'sessions:save-session') return undefined
      if (channel === 'acp:send-prompt') {
        emitEvent?.({
          id: 'event-1',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: existing.id,
          role: 'assistant',
          text: 'Follow-up answer'
        })
        return {}
      }
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
    const api = new HeadlessTaskApi(
      { invoke },
      {
        createId: (() => {
          const ids = ['new-user', 'run-2', 'new-agent']
          return () => ids.shift() ?? 'generated-id'
        })(),
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Follow-up question',
      permissionProfile: 'auto'
    })
    await api.waitForRun('run-2')

    expect(invoke).toHaveBeenCalledWith('acp:resume-session', expect.any(String), [
      expect.objectContaining({ sessionId: existing.id, permissionProfile: 'auto' })
    ])
    expect(invoke).toHaveBeenCalledWith('acp:send-prompt', expect.any(String), [
      {
        sessionId: existing.id,
        text: 'Follow-up question',
        historyPreamble:
          'Previous conversation:\n\nUser: Initial question\n\nAssistant: Initial answer'
      }
    ])
  })

  it('finalizes artifacts and persists the session when a prompt fails', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const savedSessions: PersistedChatSession[] = []
    const invoke = vi.fn(async (channel: string, _clientId: string, args: unknown[]) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'acp:create-session') {
        return { sessionId: 'session-failed', cwd: '/workspace/session-failed' }
      }
      if (channel === 'sessions:save-session') {
        savedSessions.push(structuredClone(args[0]) as PersistedChatSession)
        return undefined
      }
      if (channel === 'acp:send-prompt') {
        emitEvent?.({
          id: 'artifact-event',
          timestamp: 10,
          kind: 'artifact',
          level: 'info',
          sessionId: 'session-failed',
          artifactClaimId: 'claim-1',
          artifacts: []
        })
        emitEvent?.({
          id: 'error-event',
          timestamp: 11,
          kind: 'error',
          level: 'error',
          sessionId: 'session-failed',
          text: 'Provider rejected the request.'
        })
        throw new Error('raw provider failure')
      }
      if (channel === 'artifacts:finalize-run') {
        return [
          {
            id: 'artifact-1',
            projectName: project.id,
            sessionId: 'session-failed',
            messageId: 'agent-message',
            name: 'partial-report.md',
            path: '/artifacts/partial-report.md',
            fileUrl: 'open-science-preview://artifact-1/partial-report.md',
            mimeType: 'text/markdown',
            size: 10,
            mtimeMs: 12
          }
        ]
      }
      throw new Error(`Unexpected RPC channel: ${channel}`)
    })
    const api = new HeadlessTaskApi(
      { invoke },
      {
        createId: (() => {
          const ids = ['user-message', 'run-failed', 'agent-message']
          return () => ids.shift() ?? 'generated-id'
        })(),
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    await api.startRun({ project: project.id, prompt: 'Create a report.' })
    const failed = await api.waitForRun('run-failed')

    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-1', name: 'partial-report.md' }]
    })
    expect(invoke).toHaveBeenCalledWith('artifacts:finalize-run', expect.any(String), [
      { claimId: 'claim-1', messageId: 'agent-message' }
    ])
    expect(savedSessions.at(-1)).toMatchObject({
      status: 'error',
      error: 'Provider rejected the request.',
      artifacts: [{ id: 'artifact-1', name: 'partial-report.md' }]
    })
  })
})
