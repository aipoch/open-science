import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { TaskRunProgressEvent } from '../../shared/task-api'
import type { ApplicationEvent } from '../application-events'
import {
  projectPublicTaskEvent,
  projectPublicTaskProgressEvent,
  projectTaskRuntimeEvent,
  projectWebRendererEvent
} from './application-event-projections'

describe('application event projections', () => {
  const activeRun = {
    runId: 'run-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  }

  it('projects Task-owned progress without routing it through renderer events', () => {
    const progress: TaskRunProgressEvent = {
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      phase: 'provider-accepted',
      timestamp: 1_700_000_000_000,
      elapsedMs: 250,
      heartbeat: false
    }

    expect(projectPublicTaskProgressEvent(progress)).toEqual({
      ...activeRun,
      type: 'run.progress',
      data: progress
    })
  })

  it('passes terminal usage metadata through every eligible surface without recomputation', () => {
    const payload: AcpRuntimeEvent = {
      id: 'event-1',
      timestamp: 1_700_000_000_000,
      kind: 'stop',
      level: 'info',
      sessionId: 'session-1',
      turnUsage: {
        inputTokens: 12,
        cacheTokens: 7,
        cachedReadTokens: 5,
        cachedWriteTokens: 2,
        outputTokens: 4,
        turnCount: 3
      },
      raw: { providerSessionId: 'non-uuid-session' }
    }
    const event: ApplicationEvent<'acp:event'> = { channel: 'acp:event', payload: [payload] }

    expect(projectTaskRuntimeEvent(event)).toBe(payload)
    expect(projectWebRendererEvent(event)).toEqual({
      protocolVersion: 1,
      channel: 'acp:event',
      payload: [payload]
    })
    expect(projectPublicTaskEvent(event)).toBeUndefined()
    expect(projectPublicTaskEvent(event, () => activeRun)).toEqual({
      ...activeRun,
      type: 'run.event',
      data: payload
    })
  })

  it('keeps Specialist events out of Web and public Task surfaces', () => {
    const catalogChanged: ApplicationEvent<'specialist:catalog-changed'> = {
      channel: 'specialist:catalog-changed',
      payload: undefined
    }
    const pendingSwitch: ApplicationEvent<'specialist:pending-switch'> = {
      channel: 'specialist:pending-switch',
      payload: { sessionId: 'session-1', targetName: 'Analyst' }
    }

    for (const event of [catalogChanged, pendingSwitch]) {
      expect(projectWebRendererEvent(event)).toBeUndefined()
      expect(projectPublicTaskEvent(event)).toBeUndefined()
      expect(projectTaskRuntimeEvent(event)).toBeUndefined()
    }
  })

  it('projects Reviewer events to Web while keeping them out of public Task', () => {
    const events: ApplicationEvent[] = [
      { channel: 'reviewer:updated', payload: { review: {} as never } },
      {
        channel: 'reviewer:suppress-next-auto-review',
        payload: { projectId: 'project-1', appSessionId: 'session-1' }
      },
      {
        channel: 'reviewer:fix-loop-start',
        payload: { projectId: 'project-1', appSessionId: 'session-1' }
      },
      {
        channel: 'reviewer:fix-loop-end',
        payload: { projectId: 'project-1', appSessionId: 'session-1' }
      }
    ]

    for (const event of events) {
      expect(projectWebRendererEvent(event)).toEqual({
        protocolVersion: 1,
        channel: event.channel,
        payload: event.payload
      })
      expect(projectPublicTaskEvent(event)).toBeUndefined()
      expect(projectTaskRuntimeEvent(event)).toBeUndefined()
    }
  })

  it('keeps public Task events to the existing two-channel allowlist', () => {
    const permission: ApplicationEvent<'acp:permission-request'> = {
      channel: 'acp:permission-request',
      payload: {
        requestId: 'permission-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        title: 'Run command',
        options: []
      }
    }
    const compute: ApplicationEvent<'compute:job-updated'> = {
      channel: 'compute:job-updated',
      payload: {} as Extract<ApplicationEvent, { channel: 'compute:job-updated' }>['payload']
    }

    expect(projectPublicTaskEvent(permission)).toBeUndefined()
    expect(projectPublicTaskEvent(permission, () => activeRun)).toEqual({
      ...activeRun,
      type: 'permission.requested',
      data: permission.payload
    })
    expect(projectPublicTaskEvent(compute)).toBeUndefined()
  })
})
