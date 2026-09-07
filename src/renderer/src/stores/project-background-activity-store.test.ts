import { beforeEach, describe, expect, it } from 'vitest'

import type { ProjectBackgroundActivity } from '../../../shared/background-result-delivery'
import {
  EMPTY_ACTIVITY,
  useProjectBackgroundActivityStore
} from './project-background-activity-store'

const snapshot = (
  updatedAt: number,
  status: 'running' | 'completed'
): ProjectBackgroundActivity => ({
  truncated: false,
  items: [
    {
      id: 'local-run:run-1',
      sourceKind: 'local-run',
      sourceId: 'run-1',
      executionType: 'python',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'QC',
      lane: 'Kernel · Python',
      status,
      active: status === 'running',
      needsAttention: false,
      updatedAt
    }
  ]
})

describe('Project background activity store', () => {
  beforeEach(() =>
    useProjectBackgroundActivityStore.setState({ projectId: undefined, snapshot: EMPTY_ACTIVITY })
  )

  it('replaces the projection supplied by the request-sequenced caller', () => {
    const store = useProjectBackgroundActivityStore.getState()
    store.hydrate('project-1', snapshot(20, 'completed'))
    store.hydrate('project-1', snapshot(10, 'running'))

    expect(useProjectBackgroundActivityStore.getState().snapshot).toEqual(snapshot(10, 'running'))
  })

  it('accepts a newer empty hydrate so consumed results disappear', () => {
    const store = useProjectBackgroundActivityStore.getState()
    store.hydrate('project-1', snapshot(20, 'completed'))
    store.hydrate('project-1', { items: [], truncated: false })

    expect(useProjectBackgroundActivityStore.getState().snapshot.items).toEqual([])
  })
})
