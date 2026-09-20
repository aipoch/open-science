import { describe, expect, it } from 'vitest'

import { searchSessionTitles, type SearchableSession } from './global-search-catalog'

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
  it('preserves session objects so result rows need no reverse lookup', () => {
    const item = { ...sessions(1)[0]!, activeMessageCount: 42 }
    const result = searchSessionTitles({
      sessions: [item],
      query: 'sin'
    })
    expect(result[0]).toBe(item)
  })

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
      query
    })

    expect(result.map((session) => session.id)).toEqual(['session-0'])
    expect(result.length).toBe(1)
    expect(result[0].title).toBe(title)
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
      query
    })

    expect(result).toEqual([])
  })

  it('uses the existing number lookup for full-width digits', () => {
    const result = searchSessionTitles({
      sessions: [
        { ...sessions(1)[0], id: 'prefix', number: 123, updatedAt: 2_000 },
        { ...sessions(1)[0], id: 'exact', number: 12 },
        { ...sessions(1)[0], id: 'title-only', title: '12', number: 7 }
      ],
      query: '１２'
    })

    expect(result.map((session) => session.id)).toEqual(['exact', 'prefix'])
  })

  it('keeps pending sessions out and retains all matching scoped sessions for pagination', () => {
    const result = searchSessionTitles({
      sessions: [...sessions(23), { ...sessions(1)[0]!, id: 'pending', isPending: true }],
      query: 'sin'
    })
    expect(result).toHaveLength(23)
    expect(result[0]!.id).toBe('session-0')
    expect(result[22]!.id).toBe('session-22')
  })

  it('orders exact numbers before prefixes while allowing explicit recency sorting', () => {
    const input = [
      { ...sessions(1)[0]!, id: 'prefix', number: 123, updatedAt: 3000 },
      { ...sessions(1)[0]!, id: 'exact', number: 12, updatedAt: 1000 },
      { ...sessions(1)[0]!, id: 'title-only', title: 'Session 12', number: 7 },
      { ...sessions(1)[0]!, id: 'missing', number: undefined },
      { ...sessions(1)[0]!, id: 'invalid', number: 0 }
    ]
    expect(searchSessionTitles({ sessions: input, query: '12' }).map((item) => item.id)).toEqual([
      'exact',
      'prefix'
    ])
    expect(
      searchSessionTitles({ sessions: input, query: '12', sort: 'recent' }).map((item) => item.id)
    ).toEqual(['prefix', 'exact'])
  })

  it('keeps large result sets linear in session identity reads', () => {
    let identityReads = 0
    const input = sessions(10000).map((session) => ({
      ...session,
      get id() {
        identityReads++
        return session.id
      }
    }))
    const result = searchSessionTitles({ sessions: input, query: 'sin' })
    expect(result.slice(0, 10).map((item) => item.id)).toEqual([
      'session-0',
      'session-1',
      'session-2',
      'session-3',
      'session-4',
      'session-5',
      'session-6',
      'session-7',
      'session-8',
      'session-9'
    ])
    expect(identityReads).toBeLessThan(100000)
    expect(result[9999]).toBe(input[9999])
  })
})
