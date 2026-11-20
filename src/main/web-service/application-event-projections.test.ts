import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { TaskRunProgressEvent } from '../../shared/task-api'
import type { ApplicationEvent } from '../application-events'
import { projectPermissionRequest } from '../acp/runtime-publication-owner'
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

  it('projects Specialist catalog changes to Web while keeping session switches and public Task private', () => {
    const catalogChanged: ApplicationEvent<'specialist:catalog-changed'> = {
      channel: 'specialist:catalog-changed',
      payload: undefined
    }
    const pendingSwitch: ApplicationEvent<'specialist:pending-switch'> = {
      channel: 'specialist:pending-switch',
      payload: { sessionId: 'session-1', targetName: 'Analyst' }
    }

    expect(projectWebRendererEvent(catalogChanged)).toEqual({
      protocolVersion: 1,
      channel: 'specialist:catalog-changed',
      payload: null
    })
    expect(projectWebRendererEvent(pendingSwitch)).toBeUndefined()
    for (const event of [catalogChanged, pendingSwitch]) {
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

  it('keeps a Session-scoped public notice and leaves review details to the application', () => {
    const card = {
      sessionId: activeRun.sessionId,
      requestId: 'review-1',
      toolCallId: 'app-approval:review-1',
      title: 'Review potentially destructive code',
      appOwned: true as const,
      rawInput: { code: 'private source', notebookCodeRisk: { runId: 'notebook-1', risks: [] } },
      options: [{ optionId: 'private-option-id', kind: 'reject_once', name: 'Decline' }]
    }
    const activity = {
      id: 'event-1',
      timestamp: 1,
      level: 'info' as const,
      sessionId: card.sessionId,
      toolCallId: card.toolCallId
    }
    const trimmed = projectPermissionRequest(card)
    expect(trimmed.rawInput).toBeUndefined()
    for (const request of [card, trimmed]) {
      const permission: ApplicationEvent = { channel: 'acp:permission-request', payload: request }
      expect(projectPublicTaskEvent(permission, () => activeRun)).toEqual({
        ...activeRun,
        type: 'permission.requested',
        data: {
          sessionId: card.sessionId,
          title: 'Notebook code review is pending in this Session.',
          reasonCode: 'notebook_code_review_required'
        }
      })
      const events: ApplicationEvent<'acp:event'>[] = [
        {
          channel: 'acp:event',
          payload: [
            { ...activity, kind: 'permission', permissionRequestId: card.requestId, raw: request }
          ]
        },
        {
          channel: 'acp:event',
          payload: [{ ...activity, kind: 'tool', appOwned: true, rawInput: card.rawInput }]
        }
      ]
      for (const event of [permission, ...events]) {
        if (event.channel === 'acp:event')
          expect(projectPublicTaskEvent(event, () => activeRun)).toBeUndefined()
        expect(projectWebRendererEvent(event)?.payload).toBe(event.payload)
      }
    }
  })

  it('keeps the Notebook environment and approval options out of public Task events', () => {
    const card = {
      sessionId: activeRun.sessionId,
      requestId: 'review-runtime-1',
      toolCallId: 'app-approval:review-runtime-1',
      title: 'Confirm Notebook kernel and environment',
      appOwned: true as const,
      rawInput: {
        notebookRuntimeSelection: {
          projectId: activeRun.projectId,
          promptMessageId: 'prompt-1',
          messageBranchId: 'branch-1',
          interpreterPath: '/private/runtime/python'
        }
      },
      options: [{ optionId: 'private-option-id', kind: 'allow_once', name: 'Approve' }]
    }
    const resolveRun = (
      _sessionId: string,
      promptMessageId?: string
    ): typeof activeRun | undefined => (promptMessageId === 'prompt-1' ? activeRun : undefined)
    const notice = {
      ...activeRun,
      type: 'permission.requested',
      data: {
        sessionId: card.sessionId,
        title: 'Notebook runtime review is pending in this Session.',
        reasonCode: 'notebook_runtime_review_required'
      }
    }
    const permission: ApplicationEvent = { channel: 'acp:permission-request', payload: card }
    expect(projectPublicTaskEvent(permission, resolveRun)).toEqual(notice)
    expect(projectPublicTaskEvent(permission, () => undefined)).toBeUndefined()
    const trimmed = projectPermissionRequest({
      ...card,
      rawInput: { ...card.rawInput, extra: 'x'.repeat(10_000) }
    })
    expect(trimmed.rawInput).toBeUndefined()
    expect(
      projectPublicTaskEvent({ ...permission, payload: trimmed }, () => activeRun)
    ).toBeUndefined()
    const activity: ApplicationEvent<'acp:event'> = {
      channel: 'acp:event',
      payload: [
        {
          id: 'event-1',
          timestamp: 1,
          level: 'info',
          kind: 'permission',
          sessionId: card.sessionId,
          permissionRequestId: card.requestId,
          toolCallId: card.toolCallId,
          promptMessageId: 'prompt-1',
          raw: trimmed
        }
      ]
    }
    expect(projectPublicTaskEvent(activity, resolveRun)).toBeUndefined()
    expect(projectWebRendererEvent(permission)?.payload).toBe(card)
  })
})
