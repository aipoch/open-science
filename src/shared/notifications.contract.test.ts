import { describe, expectTypeOf, it } from 'vitest'

import type { NotificationKind, NotificationSource } from './notifications'

describe('message center projection contract', () => {
  it('keeps the inbox taxonomy limited to user-attention events', () => {
    expectTypeOf<NotificationKind>().toEqualTypeOf<
      'task.completed' | 'task.needs-attention' | 'task.failed' | 'authorization.required'
    >()
  })

  it('keeps management lifecycle events outside notification sources', () => {
    expectTypeOf<NotificationSource>().toEqualTypeOf<
      'agent-tool' | 'agent-question' | 'connector' | 'compute' | 'skill-import' | 'session-plan'
    >()
    expectTypeOf<'project' | 'session'>().not.toMatchTypeOf<NotificationSource>()
  })
})
