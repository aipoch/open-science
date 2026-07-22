import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionRequest, AcpRuntimeEvent } from '../../shared/acp'
import { ACP_PROMPT_FAILED_EVENT_TITLE } from '../../shared/acp'
import {
  describePermissionNotification,
  describeTaskNotification,
  TaskNotificationService,
  type TaskNotificationRequest
} from './task-notifications'

const stopEvent = (stopReason: string, sessionId = 'session-1'): AcpRuntimeEvent => ({
  id: 'event-1',
  timestamp: 1,
  kind: 'stop',
  level: 'info',
  sessionId,
  title: 'Prompt stopped',
  text: stopReason
})

const errorEvent = (
  text: string,
  options: { sessionId?: string; recoverable?: 'context-overflow'; title?: string } = {}
): AcpRuntimeEvent => ({
  id: 'event-2',
  timestamp: 1,
  kind: 'error',
  level: 'error',
  sessionId: options.sessionId ?? 'session-1',
  title: options.title ?? ACP_PROMPT_FAILED_EVENT_TITLE,
  text,
  ...(options.recoverable ? { recoverable: options.recoverable } : {})
})

const permissionRequest = (title: string, sessionId = 'session-1'): AcpPermissionRequest => ({
  requestId: 'req-1',
  sessionId,
  toolCallId: 'tool-1',
  title,
  options: [],
  raw: {}
})

describe('describePermissionNotification', () => {
  it('names the task and the tool waiting for approval', () => {
    expect(
      describePermissionNotification(permissionRequest('Run command'), 'Plot the curve')
    ).toEqual({
      title: 'Approval needed',
      body: '"Plot the curve" needs your approval: Run command'
    })
  })

  it('falls back to a generic body when no prompt was tracked', () => {
    expect(describePermissionNotification(permissionRequest('Edit results.csv'))).toEqual({
      title: 'Approval needed',
      body: 'The agent needs your approval: Edit results.csv'
    })
  })

  it('truncates long tool titles so platform limits cannot clip the status away', () => {
    const notification = describePermissionNotification(
      permissionRequest(`Bash: ${'x'.repeat(300)}`),
      'Plot the curve'
    )

    expect(notification.body.length).toBeLessThanOrEqual(200)
    expect(notification.body.endsWith('…')).toBe(true)
  })
})

describe('describeTaskNotification', () => {
  it('names the task from the prompt snippet when a turn completes', () => {
    expect(describeTaskNotification(stopEvent('end_turn'), 'Plot the curve')).toEqual({
      title: 'Task completed',
      body: '"Plot the curve" finished.'
    })
  })

  it('falls back to a generic body when no prompt was tracked', () => {
    expect(describeTaskNotification(stopEvent('end_turn'))).toEqual({
      title: 'Task completed',
      body: 'The agent finished your request.'
    })
  })

  it('stays silent for user-cancelled turns', () => {
    expect(describeTaskNotification(stopEvent('cancelled'), 'Plot the curve')).toBeNull()
  })

  it('explains a max_tokens stop in plain language', () => {
    expect(describeTaskNotification(stopEvent('max_tokens'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      body: '"Plot the curve" stopped early — the answer hit the model\'s length limit.'
    })
  })

  it('explains a max_turn_requests stop as waiting for the user', () => {
    expect(describeTaskNotification(stopEvent('max_turn_requests'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      body: '"Plot the curve" paused — send a message to keep it going.'
    })
  })

  it('explains a refusal without jargon', () => {
    expect(describeTaskNotification(stopEvent('refusal'), 'Plot the curve')).toEqual({
      title: 'Task needs attention',
      body: '"Plot the curve" was declined by the agent.'
    })
    expect(describeTaskNotification(stopEvent('refusal'))?.body).toBe(
      'The agent declined the request.'
    )
  })

  it('includes the error text when a turn fails', () => {
    expect(describeTaskNotification(errorEvent('Rate limit reached'), 'Plot the curve')).toEqual({
      title: 'Task failed',
      body: '"Plot the curve" failed: Rate limit reached'
    })
  })

  it('stays silent for recoverable context overflows (the renderer auto-retries)', () => {
    expect(
      describeTaskNotification(
        errorEvent('Prompt is too long', { recoverable: 'context-overflow' }),
        'Plot the curve'
      )
    ).toBeNull()
  })

  it.each(['Artifact cleanup failed', 'Prompt cancellation timed out'])(
    'stays silent for ancillary session-scoped errors (%s)',
    (title) => {
      expect(describeTaskNotification(errorEvent('boom', { title }), 'Plot the curve')).toBeNull()
    }
  )

  it('ignores non-terminal events', () => {
    const event: AcpRuntimeEvent = {
      id: 'event-3',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: 'session-1',
      text: 'working…'
    }

    expect(describeTaskNotification(event, 'Plot the curve')).toBeNull()
  })

  it('truncates long bodies so platform limits cannot clip the status away', () => {
    const longSnippet = 'x'.repeat(200)
    const notification = describeTaskNotification(errorEvent('boom'), longSnippet)

    expect(notification?.body.length).toBeLessThanOrEqual(200)
    expect(notification?.body.endsWith('…')).toBe(true)
  })
})

// Drives the service with injected gates so each filtering rule is pinned independently.
const createService = (overrides: {
  isEnabled?: () => Promise<boolean>
  isAppFocused?: () => boolean
  show?: (request: TaskNotificationRequest) => void
  onDeliveryError?: (error: unknown) => void
}): {
  service: TaskNotificationService
  shown: TaskNotificationRequest[]
  deliveryErrors: unknown[]
} => {
  const shown: TaskNotificationRequest[] = []
  const deliveryErrors: unknown[] = []
  const service = new TaskNotificationService({
    isEnabled: overrides.isEnabled ?? (() => Promise.resolve(true)),
    isAppFocused: overrides.isAppFocused ?? (() => false),
    show: overrides.show ?? ((request) => shown.push(request)),
    onDeliveryError: overrides.onDeliveryError ?? ((error) => deliveryErrors.push(error))
  })

  return { service, shown, deliveryErrors }
}

describe('TaskNotificationService', () => {
  it('notifies on completion using the tracked prompt as the task name', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: '\nPlot the curve\nand fit a model' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Task completed',
      body: '"Plot the curve" finished.'
    })
  })

  it('collapses multiline prompts to their first line', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'First line\nSecond line' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[0]?.body).toBe('"First line" finished.')
  })

  it('does not notify while the app is focused', async () => {
    const { service, shown } = createService({ isAppFocused: () => true })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify when the preference is disabled', async () => {
    const { service, shown } = createService({ isEnabled: () => Promise.resolve(false) })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('fails closed when the preference read throws', async () => {
    const { service, shown } = createService({
      isEnabled: () => Promise.reject(new Error('disk gone'))
    })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('stays silent for internal turns that never tracked a prompt (reviewer correction)', async () => {
    const { service, shown } = createService({})

    // The reviewer's auditor-correction calls runtime.sendPrompt directly (no IPC, no trackPrompt).
    await service.handleRuntimeEvent(stopEvent('end_turn', 'main-session'))
    await service.handleRuntimeEvent(errorEvent('boom', { sessionId: 'main-session' }))

    expect(shown).toHaveLength(0)
  })

  it('ignores terminal events without a session id', async () => {
    const { service, shown } = createService({})

    await service.handleRuntimeEvent(stopEvent('end_turn', ''))

    expect(shown).toHaveLength(0)
  })

  it('ignores non-terminal events', async () => {
    const { service, shown } = createService({})
    const event: AcpRuntimeEvent = {
      id: 'event-4',
      timestamp: 1,
      kind: 'tool',
      level: 'info',
      sessionId: 'session-1'
    }

    await service.handleRuntimeEvent(event)

    expect(shown).toHaveLength(0)
  })

  it('forgets the prompt once the turn terminates', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    // A later terminal event on the same session without a tracked prompt is not user-initiated:
    // no snippet remains, so it must stay silent.
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(1)
  })

  it('routes clicks to the activation handler with the session id', async () => {
    const { service, shown } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    shown[0]?.onClick()

    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('keeps the tracked prompt when an ancillary error precedes the turn failure', async () => {
    const { service, shown } = createService({})

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    // Cancel-timeout escalation is not the turn's terminal state.
    await service.handleRuntimeEvent(
      errorEvent('cancel timed out', { title: 'Prompt cancellation timed out' })
    )
    await service.handleRuntimeEvent(errorEvent('process killed'))

    expect(shown).toHaveLength(1)
    expect(shown[0]?.body).toBe('"Plot the curve" failed: process killed')
  })

  it('swallows delivery errors and reports them instead of rejecting', async () => {
    const boom = new Error('Notification unavailable')
    const { service, deliveryErrors } = createService({
      show: () => {
        throw boom
      }
    })

    // Must not reject: the caller voids this promise on the broadcast path.
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(deliveryErrors).toEqual([boom])
  })

  it('holds the notification click target until the renderer takes it (consume-once)', () => {
    const { service } = createService({})

    expect(service.takePendingOpenSession()).toBeNull()

    service.setPendingOpenSession('session-7')

    expect(service.takePendingOpenSession()).toEqual({ sessionId: 'session-7' })
    expect(service.takePendingOpenSession()).toBeNull()
  })

  it('notifies when a task parks on a permission request', async () => {
    const { service, shown } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      title: 'Approval needed',
      body: '"Plot the curve" needs your approval: Run command'
    })

    // Clicking surfaces the same conversation as a terminal notification.
    shown[0]?.onClick()
    expect(onActivate).toHaveBeenCalledWith('session-1')
  })

  it('stays silent for permission requests on internal turns', async () => {
    const { service, shown } = createService({})

    // No tracked prompt: the turn was not user-initiated (e.g. reviewer correction).
    await service.handlePermissionRequest(permissionRequest('Run command', 'main-session'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify for permission requests while the app is focused', async () => {
    const { service, shown } = createService({ isAppFocused: () => true })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify for permission requests when the preference is disabled', async () => {
    const { service, shown } = createService({ isEnabled: () => Promise.resolve(false) })

    service.trackPrompt({ sessionId: 'session-1', text: 'Plot the curve' })
    await service.handlePermissionRequest(permissionRequest('Run command'))

    expect(shown).toHaveLength(0)
  })
})
