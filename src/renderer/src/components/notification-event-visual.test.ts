import {
  CircleCheck,
  CircleX,
  ClipboardList,
  KeyRound,
  MessageCircleQuestion,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { describe, expect, it } from 'vitest'

import {
  notificationEventToneClasses,
  resolveNotificationEventVisual
} from './notification-event-visual'

const base = {
  kind: 'task.completed',
  attentionReason: undefined,
  actionState: undefined,
  targetInvalidatedAt: undefined
} as const

describe('resolveNotificationEventVisual', () => {
  it.each([
    ['task.completed', undefined, CircleCheck, 'success'],
    ['task.failed', undefined, CircleX, 'danger'],
    ['authorization.required', undefined, ShieldCheck, 'waiting']
  ] as const)('maps kind %s to its glyph and tone', (kind, attentionReason, Icon, tone) => {
    expect(resolveNotificationEventVisual({ ...base, kind, attentionReason })).toEqual({
      Icon,
      tone
    })
  })

  it.each([
    ['waiting-for-user', MessageCircleQuestion],
    ['waiting-permission', KeyRound],
    ['waiting-plan-approval', ClipboardList],
    ['task-max-tokens', TriangleAlert],
    ['task-max-turn-requests', TriangleAlert],
    ['task-refusal', TriangleAlert],
    ['task-unclean-stop', TriangleAlert],
    [undefined, TriangleAlert]
  ] as const)('maps needs-attention reason %s to %s', (attentionReason, Icon) => {
    const visual = resolveNotificationEventVisual({
      ...base,
      kind: 'task.needs-attention',
      attentionReason
    })
    expect(visual.Icon).toBe(Icon)
    expect(visual.tone).toBe('waiting')
  })

  it.each(['resolved', 'rejected', 'expired', 'cancelled'] as const)(
    'keeps the glyph but neutralizes the tone once %s',
    (actionState) => {
      const visual = resolveNotificationEventVisual({
        ...base,
        kind: 'authorization.required',
        actionState
      })
      expect(visual.Icon).toBe(ShieldCheck)
      expect(visual.tone).toBe('neutral')
    }
  )

  it('neutralizes pending requests whose target was invalidated', () => {
    const visual = resolveNotificationEventVisual({
      ...base,
      kind: 'task.needs-attention',
      attentionReason: 'waiting-permission',
      actionState: 'pending',
      targetInvalidatedAt: 1
    })
    expect(visual.Icon).toBe(KeyRound)
    expect(visual.tone).toBe('neutral')
  })

  it('keeps a fresh completed outcome chromatic while pending states stay colored', () => {
    expect(resolveNotificationEventVisual(base).tone).toBe('success')
    expect(
      resolveNotificationEventVisual({ ...base, kind: 'task.failed', actionState: 'pending' }).tone
    ).toBe('danger')
  })

  it('provides token-based tile and chip classes for every tone', () => {
    for (const tone of ['success', 'danger', 'waiting', 'neutral'] as const) {
      expect(notificationEventToneClasses[tone].tile).toBeTruthy()
      expect(notificationEventToneClasses[tone].chip).toContain('border')
    }
  })
})
