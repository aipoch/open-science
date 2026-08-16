import { describe, expectTypeOf, it } from 'vitest'

import type {
  NotificationAttentionReason,
  NotificationKind,
  NotificationSource
} from './notifications'

describe('message center projection contract', () => {
  it('keeps the inbox taxonomy limited to user-attention events', () => {
    expectTypeOf<NotificationKind>().toEqualTypeOf<
      'task.completed' | 'task.needs-attention' | 'task.failed' | 'authorization.required'
    >()
  })

  it('keeps management lifecycle events outside notification sources', () => {
    expectTypeOf<NotificationSource>().toEqualTypeOf<
      | 'agent-tool'
      | 'agent-question'
      | 'agent-runtime'
      | 'connector'
      | 'compute'
      | 'skill-import'
      | 'session-plan'
    >()
    expectTypeOf<'project' | 'session'>().not.toMatchTypeOf<NotificationSource>()
  })

  it('keeps notification reasons bounded to shared waits and task stop categories', () => {
    expectTypeOf<NotificationAttentionReason>().toEqualTypeOf<
      | 'waiting-for-user'
      | 'waiting-permission'
      | 'waiting-plan-approval'
      | 'task-max-tokens'
      | 'task-max-turn-requests'
      | 'task-refusal'
      | 'task-unclean-stop'
    >()
  })
})
