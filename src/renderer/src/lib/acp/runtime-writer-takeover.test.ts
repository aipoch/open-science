import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeWriterOwner } from '../../../../main/session-persistence/runtime-writer'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../stores/session-store'
import { applyWorkspaceRuntimeEvent } from './workspace-events'
import { processIncrementalWorkspaceRuntimeEvents } from './workspace-runtime-event-owner'

afterEach(() => vi.unstubAllGlobals())
it('a successor reloads durable messages before replaying the host window without duplicating text', async () => {
  let now = 0
  vi.stubGlobal('performance', { now: () => now })
  const owner = new RuntimeWriterOwner(() => now)
  owner.claim('electron:desktop')
  const base = {
    id: 'session',
    projectId: 'project',
    title: 'Existing',
    cwd: '/test',
    status: 'running' as const,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1
  }
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().hydrateSessions([base])
  const event = {
    id: 'text-already-saved',
    kind: 'message' as const,
    role: 'assistant' as const,
    level: 'info' as const,
    sessionId: 'session',
    runId: 'run',
    timestamp: 2,
    text: 'Already saved by desktop'
  }
  await applyWorkspaceRuntimeEvent(event)
  const durable = { ...toPersistedSession(useSessionStore.getState().sessions[0]), revision: 2 }
  expect(durable.messages).toHaveLength(1)
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().hydrateSessions([base])
  const loadOne = vi.fn(async () => durable)
  vi.stubGlobal('window', {
    api: {
      lifecycle: { claimRuntimeWriter: vi.fn(async () => owner.claim('web:phone')) },
      sessions: { loadOne },
      acp: { getState: vi.fn(async () => ({ events: [event] })) }
    }
  })
  await processIncrementalWorkspaceRuntimeEvents([event])
  expect(useSessionStore.getState().sessions[0].messages).toHaveLength(0)
  now = 21_000
  await processIncrementalWorkspaceRuntimeEvents([event])
  expect(loadOne).toHaveBeenCalledTimes(1)
  expect(useSessionStore.getState().sessions[0].messages).toEqual(durable.messages)
  expect(useSessionStore.getState().streamingMessages).toEqual({})
})
