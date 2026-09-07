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
    number: index + 1,
    updatedAt: 1_000 - index,
    artifactCount: index,
    isPending: false
  }))

describe('global search catalog', () => {
  it.each([
    ['Übersicht', 'übersicht'],
    ['ÉTUDE', 'étude'],
    ['ТЕСТ', 'тест'],
    ['Analysis', 'ＡＮＡＬＹＳＩＳ'],
    ['Étude', 'E\u0301tude'],
    ['ＡＮＡＬＹＳＩＳ', 'analysis'],
    ['E\u0301tude', 'étude'],
    ['ﬀ analysis', 'ff'],
    ['Ⓓ analysis', 'd'],
    ['İstanbul', 'İ'],
    ['İstanbul', 'i\u0307'],
    ['İstanbul in summer', 'i'],
    ['Literal [.*+?^${}()|\\] query', '[.*+?^${}()|\\]'],
    ['İstanbul', '']
  ])('finds title %s using query %s', (title, query) => {
    const result = searchSessionTitles({
      sessions: [{ ...sessions(1)[0], title }],
      projectNames: new Map([['project-a', 'Alpha']]),
      primaryProjectId: 'project-a',
      query,
      visiblePrimaryCount: 8
    })

    expect(result.primary.map((session) => session.id)).toEqual(['session-0'])
    expect(result.primaryTotalCount).toBe(1)
    expect(result.primary[0].title).toBe(title)
  })

  it.each([
    ['Étude', 'etude'],
    ['Übersicht', 'ubersicht'],
    ['Straße', 'strasse'],
    ['İstanbul', 'i'],
    ['i\u0307stanbul', 'i'],
    ['i\u0307\u0301stanbul', 'i\u0307'],
    ['No wildcard match', '.*']
  ])('keeps title %s distinct from query %s', (title, query) => {
    const result = searchSessionTitles({
      sessions: [{ ...sessions(1)[0], title }],
      projectNames: new Map([['project-a', 'Alpha']]),
      primaryProjectId: 'project-a',
      query,
      visiblePrimaryCount: 8
    })

    expect(result.primary).toEqual([])
  })

  it('uses the existing number lookup for full-width digits', () => {
    const result = searchSessionTitles({
      sessions: [
        { ...sessions(1)[0], id: 'prefix', number: 123, updatedAt: 2_000 },
        { ...sessions(1)[0], id: 'exact', number: 12 },
        { ...sessions(1)[0], id: 'title-only', title: '12', number: 7 }
      ],
      projectNames: new Map([['project-a', 'Alpha']]),
      primaryProjectId: 'project-a',
      query: '１２',
      visiblePrimaryCount: 8
    })

    expect(result.primary.map((session) => session.id)).toEqual(['exact', 'prefix'])
  })

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

  it('matches positive Session-number prefixes and ranks an exact number first', () => {
    const result = searchSessionTitles({
      sessions: [
        { ...sessions(1)[0], id: 'newer-prefix', number: 123, updatedAt: 3_000 },
        { ...sessions(1)[0], id: 'exact', number: 12, updatedAt: 1_000 },
        { ...sessions(1)[0], id: 'older-prefix', number: 120, updatedAt: 2_000 },
        { ...sessions(1)[0], id: 'title-only', title: 'Session 12', number: 7, updatedAt: 4_000 },
        { ...sessions(1)[0], id: 'missing', number: undefined, updatedAt: 5_000 },
        { ...sessions(1)[0], id: 'invalid', number: 0, updatedAt: 6_000 }
      ],
      projectNames: new Map([['project-a', 'Alpha']]),
      primaryProjectId: 'project-a',
      query: '12',
      visiblePrimaryCount: 8
    })

    expect(result.primary.map((session) => session.id)).toEqual([
      'exact',
      'newer-prefix',
      'older-prefix'
    ])
  })

  it('promotes an exact Session-number match from another Project ahead of local prefixes', () => {
    const result = searchSessionTitles({
      sessions: [
        { ...sessions(1)[0], id: 'local-prefix', number: 123, updatedAt: 3_000 },
        {
          ...sessions(1, 'project-b')[0],
          id: 'cross-project-exact',
          number: 12,
          updatedAt: 1_000
        },
        {
          ...sessions(1, 'project-b')[0],
          id: 'cross-project-prefix',
          number: 120,
          updatedAt: 2_000
        }
      ],
      projectNames: new Map([
        ['project-a', 'Alpha'],
        ['project-b', 'Beta']
      ]),
      primaryProjectId: 'project-a',
      query: '12',
      visiblePrimaryCount: 8
    })

    expect(result.primary.map((session) => session.id)).toEqual([
      'cross-project-exact',
      'local-prefix'
    ])
    expect(result.primary[0].projectName).toBe('Beta')
    expect(result.other.map((session) => session.id)).toEqual(['cross-project-prefix'])
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
