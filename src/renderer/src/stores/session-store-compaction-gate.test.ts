import { describe, expect, it } from 'vitest'
import { hydrateSession, type ChatSession } from './session-store-persistence-owner'
import {
  projectCompactionStarted,
  projectCompactionFinished
} from './session-store-run-terminal-helpers'
import { createInitialSessionState, useSessionStore } from './session-store'

const sourceSession = (): ChatSession =>
  hydrateSession({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Analysis',
    cwd: '/workspace',
    status: 'error',
    error: 'Context window exceeded',
    errorReportable: false,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Analyze data',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        turnOutcome: {
          kind: 'failed',
          settledAt: 2,
          error: 'Context window exceeded',
          errorReportable: false
        }
      }
    ],
    createdAt: 1,
    updatedAt: 2
  })

describe('compaction command gate', () => {
  it('retains the Main terminal outcome and transcript across a failed control command', () => {
    const source = sourceSession()
    const started = projectCompactionStarted(source)
    expect(started).toEqual({ ...source, compacting: true })
    expect(started.messages).toBe(source.messages)
    expect(started.conversationGraph).toBe(source.conversationGraph)
    expect(projectCompactionFinished(started)).toEqual(source)
  })

  it('does not release an admitted run to admit automatic recovery', () => {
    const source = {
      ...sourceSession(),
      status: 'running' as const,
      activeRun: { promptMessageId: 'prompt', startedAt: 3 }
    }
    expect(projectCompactionStarted(source)).toBe(source)
  })

  it('uses ordinary transient projection without materializing or settling streaming state', () => {
    const source = sourceSession()
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [source] })
    useSessionStore.getState().beginCompaction(source.id)
    const gated = useSessionStore.getState().sessions[0]
    expect(gated.messages).toBe(source.messages)
    expect(gated.status).toBe(source.status)
    expect(gated.error).toBe(source.error)
    useSessionStore.getState().finishCompaction(source.id)
    expect(useSessionStore.getState().sessions[0]).toEqual(source)
  })
})
