import { describe, expect, it } from 'vitest'

import type { NotificationInboxItem } from '../../../shared/notifications'
import type { Project } from '../../../shared/projects'
import type { ChatSession } from '@/stores/session-store'
import { presentNotificationInbox } from './notification-inbox-presentation'

const notification = (overrides: Partial<NotificationInboxItem> = {}): NotificationInboxItem => ({
  id: 'notification-1',
  sequence: 1,
  dedupeKey: 'task:event-1',
  kind: 'task.completed',
  source: 'agent-runtime',
  sessionId: 'session-1',
  originId: 'event-1',
  title: 'Task completed',
  summary: 'A task completed.',
  createdAt: 100,
  ...overrides
})

const session = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analyze microscopy data',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'Analyze microscopy data',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
} as ChatSession

const project = { id: 'project-1', name: 'Cell atlas' } as Project

describe('presentNotificationInbox', () => {
  it('adds Project and task context without repeating the first prompt as every preview', () => {
    const item = notification()

    const groups = presentNotificationInbox([item], [session], [project])

    expect(groups).toEqual([
      {
        key: 'unread',
        label: 'Unread',
        items: [
          {
            notification: item,
            projectName: 'Cell atlas',
            sessionTitle: 'Analyze microscopy data'
          }
        ]
      }
    ])
  })

  it('uses the user prompt belonging to the notification time instead of the first or latest turn', () => {
    const multiTurnSession = {
      ...session,
      messages: [
        session.messages[0],
        {
          ...session.messages[0],
          id: 'prompt-2',
          content: 'Use a logarithmic scale for the chart.',
          createdAt: 20,
          updatedAt: 20
        },
        {
          ...session.messages[0],
          id: 'prompt-3',
          content: 'Export the chart as SVG.',
          createdAt: 40,
          updatedAt: 40
        }
      ]
    }

    const presented = presentNotificationInbox(
      [notification({ createdAt: 30 })],
      [multiTurnSession],
      [project]
    )[0]?.items[0]

    expect(presented?.detailPreview).toBe('Use a logarithmic scale for the chart.')
  })

  it('selects the closest preceding prompt even when cached messages are out of order', () => {
    const outOfOrderSession = {
      ...session,
      messages: [
        { ...session.messages[0], id: 'prompt-3', content: 'Third prompt', createdAt: 30 },
        { ...session.messages[0], id: 'prompt-1', content: 'First prompt', createdAt: 10 },
        { ...session.messages[0], id: 'prompt-2', content: 'Second prompt', createdAt: 20 }
      ]
    }

    const presented = presentNotificationInbox(
      [notification({ createdAt: 25 })],
      [outOfOrderSession],
      [project]
    )[0]?.items[0]

    expect(presented?.detailPreview).toBe('Second prompt')
  })

  it('uses the matching Agent question and bounds long preview text', () => {
    const questionSession = {
      ...session,
      activities: [
        {
          id: 'tool-1',
          elicitation: {
            state: 'pending',
            message: `Which cohort should be used? ${'x'.repeat(220)}`,
            fields: [],
            durable: { kind: 'agent-user-choice', requestId: 'question-1' }
          }
        }
      ]
    } as unknown as ChatSession

    const presented = presentNotificationInbox(
      [
        notification({
          source: 'agent-question',
          originId: 'question-1',
          kind: 'task.needs-attention'
        })
      ],
      [questionSession],
      [project]
    )[0]?.items[0]

    expect(presented?.detailPreview?.length).toBeLessThanOrEqual(180)
    expect(presented?.detailPreview).toMatch(/^Which cohort should be used\? /)
    expect(presented?.detailPreview).toMatch(/…$/)
  })

  it('puts unread messages first, then restores read messages to newest-first chronology', () => {
    const completed = notification({ id: 'completed', createdAt: 300, readAt: 400 })
    const failed = notification({
      id: 'failed',
      kind: 'task.failed',
      title: 'Task failed',
      createdAt: 100
    })
    const pending = notification({
      id: 'pending',
      kind: 'authorization.required',
      actionState: 'pending',
      createdAt: 200
    })

    const groups = presentNotificationInbox([failed, completed, pending], [], [])

    expect(groups.map((group) => group.key)).toEqual(['unread', 'earlier'])
    expect(groups[0]?.items.map((item) => item.notification.id)).toEqual(['pending', 'failed'])
    expect(groups[1]?.items.map((item) => item.notification.id)).toEqual(['completed'])

    const afterMarkingFailedRead = presentNotificationInbox(
      [{ ...failed, readAt: 500 }, completed, pending],
      [],
      []
    )
    expect(afterMarkingFailedRead[0]?.items.map((item) => item.notification.id)).toEqual([
      'pending'
    ])
    expect(afterMarkingFailedRead[1]?.items.map((item) => item.notification.id)).toEqual([
      'completed',
      'failed'
    ])
  })

  it('falls back to the stored notification copy when its Session is unavailable', () => {
    const item = notification()

    expect(presentNotificationInbox([item], [], [project])[0]?.items[0]).toEqual({
      notification: item
    })
  })

  it('drops malformed presentation text instead of throwing', () => {
    const malformedSession = {
      ...session,
      title: null,
      messages: [{ ...session.messages[0], content: null }]
    } as unknown as ChatSession
    const malformedProject = { ...project, name: null } as unknown as Project

    expect(() =>
      presentNotificationInbox([notification()], [malformedSession], [malformedProject])
    ).not.toThrow()
    expect(
      presentNotificationInbox([notification()], [malformedSession], [malformedProject])[0]
        ?.items[0]
    ).toEqual({ notification: notification() })
  })
})
