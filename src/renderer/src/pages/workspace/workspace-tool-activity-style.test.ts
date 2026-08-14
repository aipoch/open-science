import { describe, expect, it } from 'vitest'

import type { ToolActivity } from '@/stores/session-store'

import { getActivitySurfaceClassName } from './workspace-tool-activity-style'

const activity: ToolActivity = {
  id: 'tool-1',
  kind: 'tool',
  title: 'Notebook cell',
  status: 'completed',
  eventIds: ['event-1'],
  sortIndex: 1,
  createdAt: 1,
  updatedAt: 1
}

describe('getActivitySurfaceClassName', () => {
  it('keeps active and inactive surface classes when an execution phase is provided', () => {
    expect(getActivitySurfaceClassName(activity, 'executing')).toContain(
      'text-text-000 hover:bg-bg-300'
    )
    expect(getActivitySurfaceClassName(activity, 'completed')).toContain(
      'text-text-100 hover:bg-bg-200'
    )
  })

  it('keeps the danger surface for failed execution', () => {
    expect(getActivitySurfaceClassName(activity, 'failed')).toContain(
      'text-danger-000 hover:bg-danger-900'
    )
  })
})
