import { describe, expect, it } from 'vitest'

import {
  getNextBatchCount,
  getRecentSessions,
  searchSessionTitles,
  type SearchableSession
} from './global-search-catalog'

const sessions = (count: number, projectId = 'project-a'): SearchableSession[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    projectId,
    title: `Python sin ${index}`,
    updatedAt: 1_000 - index,
    artifactCount: index,
    isPending: false
  }))

describe('global search catalog', () => {
  it('matches Session titles, partitions other projects, and reveals primary results in batches of eight', () => {
    const result = searchSessionTitles({
      sessions: [
        ...sessions(14),
        ...sessions(7, 'project-b'),
        {
          id: 'pending-match',
          projectId: 'project-a',
          title: 'Python sin pending',
          updatedAt: 2_000,
          artifactCount: 0,
          isPending: true
        },
        {
          id: 'body-only',
          projectId: 'project-a',
          title: 'Unrelated title',
          updatedAt: 3_000,
          artifactCount: 0,
          isPending: false
        }
      ],
      projectNames: new Map([
        ['project-a', 'Alpha'],
        ['project-b', 'Beta']
      ]),
      primaryProjectId: 'project-a',
      query: 'SIN',
      visiblePrimaryCount: 8
    })

    expect(result.primary).toHaveLength(8)
    expect(result.primaryTotalCount).toBe(14)
    expect(result.other).toHaveLength(5)
    expect(result.other[0]).toEqual(
      expect.objectContaining({ id: 'session-0', projectId: 'project-b', projectName: 'Beta' })
    )
    expect(getNextBatchCount(result.primaryTotalCount, result.primary.length)).toBe(6)
  })

  it('searches every Project as the primary result set when no Project scope is active', () => {
    const result = searchSessionTitles({
      sessions: [...sessions(3), ...sessions(3, 'project-b')],
      projectNames: new Map([
        ['project-a', 'Alpha'],
        ['project-b', 'Beta']
      ]),
      primaryProjectId: undefined,
      query: 'sin',
      visiblePrimaryCount: 5
    })

    expect(result.primary).toHaveLength(5)
    expect(result.primaryTotalCount).toBe(6)
    expect(result.other).toEqual([])
  })

  it('returns recent non-pending sessions in recency order with a five-row cap', () => {
    const recent = getRecentSessions(
      [
        ...sessions(7),
        {
          id: 'pending',
          projectId: 'project-a',
          title: 'Pending',
          updatedAt: 9_999,
          artifactCount: 0,
          isPending: true
        }
      ],
      'project-a'
    )

    expect(recent.map((session) => session.id)).toEqual([
      'session-0',
      'session-1',
      'session-2',
      'session-3',
      'session-4'
    ])
  })
})
