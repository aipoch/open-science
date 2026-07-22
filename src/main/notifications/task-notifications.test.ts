import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
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
  options: { sessionId?: string; recoverable?: 'context-overflow' } = {}
): AcpRuntimeEvent => ({
  id: 'event-2',
  timestamp: 1,
  kind: 'error',
  level: 'error',
  sessionId: options.sessionId ?? 'session-1',
  title: 'Prompt failed',
  text,
  ...(options.recoverable ? { recoverable: options.recoverable } : {})
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

  it.each(['max_tokens', 'max_turn_requests', 'refusal'])(
    'flags %s stops as needing attention',
    (stopReason) => {
      expect(describeTaskNotification(stopEvent(stopReason), 'Plot the curve')).toEqual({
        title: 'Task needs attention',
        body: `"Plot the curve" stopped early: ${stopReason.replaceAll('_', ' ')}.`
      })
    }
  )

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
}): { service: TaskNotificationService; shown: TaskNotificationRequest[] } => {
  const shown: TaskNotificationRequest[] = []
  const service = new TaskNotificationService({
    isEnabled: overrides.isEnabled ?? (() => Promise.resolve(true)),
    isAppFocused: overrides.isAppFocused ?? (() => false),
    show: (request) => shown.push(request)
  })

  return { service, shown }
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

    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('does not notify when the preference is disabled', async () => {
    const { service, shown } = createService({ isEnabled: () => Promise.resolve(false) })

    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown).toHaveLength(0)
  })

  it('fails closed when the preference read throws', async () => {
    const { service, shown } = createService({
      isEnabled: () => Promise.reject(new Error('disk gone'))
    })

    await service.handleRuntimeEvent(stopEvent('end_turn'))

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
    // A later turn on the same session without a tracked prompt gets the generic body.
    await service.handleRuntimeEvent(stopEvent('end_turn'))

    expect(shown[1]?.body).toBe('The agent finished your request.')
  })

  it('routes clicks to the activation handler with the session id', async () => {
    const { service, shown } = createService({})
    const onActivate = vi.fn()

    service.setActivationHandler(onActivate)
    await service.handleRuntimeEvent(stopEvent('end_turn'))
    shown[0]?.onClick()

    expect(onActivate).toHaveBeenCalledWith('session-1')
  })
})
