import { expect, it } from 'vitest'
import { projectUpdateBlockedTasks } from './blocked-tasks'
it('uses persisted titles only for current authoritative blockers and preserves project identity', () => {
  expect(
    projectUpdateBlockedTasks(
      [
        { projectId: 'p', sessionId: 'a', kind: 'agent' },
        { projectId: 'p', sessionId: 'b', kind: 'delegated' },
        { projectId: 'p', sessionId: 'missing', kind: 'agent' }
      ],
      [
        { projectId: 'p', id: 'a', title: 'Actual experiment' },
        { projectId: 'other', id: 'missing', title: 'Wrong project' },
        { projectId: 'p', id: 'b', title: 'Delegation' }
      ],
      ['agent', 'settings-install']
    )
  ).toEqual([{ projectId: 'p', sessionId: 'a', kind: 'agent', title: 'Actual experiment' }])
})
