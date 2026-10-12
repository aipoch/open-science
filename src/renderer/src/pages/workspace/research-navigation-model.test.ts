import { describe, expect, it } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import {
  buildResearchNavigation,
  importedResearchSource,
  visibleResearchNavigationRows
} from './research-navigation-model'

const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '/project',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...extra
})

describe('research sidebar navigation', () => {
  it('groups cold summaries by explicit local import identity, preserving ordinary sessions', () => {
    const source = session('source', {
      importedResearch: { importId: 'import-a' },
      contentLoaded: false
    })
    const membership = importedResearchSource(source)!
    const child = session('child', { researchMembership: membership, contentLoaded: false })
    const legacy = session('legacy', {
      runtimeContext: {
        version: 1,
        revision: 1,
        sessionContext: {
          version: 1,
          bindings: [
            {
              projectId: 'project',
              sessionId: 'source',
              contextId: 'reference',
              title: 'source',
              branchId: 'branch',
              promptMessageId: 'prompt'
            }
          ]
        }
      }
    })
    const importLookingId = session('import-ordinary')
    const model = buildResearchNavigation([source, child, legacy, importLookingId])
    expect(model.research).toHaveLength(1)
    expect(model.research[0].discussions.map((row) => row.id)).toEqual(['child'])
    expect(model.ordinary.map((row) => row.id)).toEqual(['legacy', 'import-ordinary'])
  })

  it('keeps duplicate imports separate and refuses cross-project or stale-import ownership', () => {
    const first = session('first', { importedResearch: { importId: 'a' }, title: 'Same package' })
    const second = session('second', { importedResearch: { importId: 'b' }, title: 'Same package' })
    const model = buildResearchNavigation([
      first,
      second,
      session('first-child', { researchMembership: importedResearchSource(first) }),
      session('second-child', { researchMembership: importedResearchSource(second) }),
      session('cross-project', {
        projectId: 'other',
        researchMembership: importedResearchSource(first)
      }),
      session('old-import', {
        researchMembership: { ...importedResearchSource(first)!, sourceImportId: 'stale' }
      })
    ])
    expect(model.research.map((group) => group.discussions.map((row) => row.id))).toEqual([
      ['first-child'],
      ['second-child']
    ])
    expect(model.ordinary.map((row) => row.id)).toEqual(['cross-project', 'old-import'])
  })

  it('keeps discussions accessible when their source is absent or archived', () => {
    const source = session('source', { importedResearch: { importId: 'a' } })
    const child = session('child', { researchMembership: importedResearchSource(source) })
    for (const sources of [[], [{ ...source, archivedAt: 10 }]]) {
      const model = buildResearchNavigation([...sources, child])
      expect(model.research).toEqual([])
      expect(model.ordinary).toEqual([child])
    }
    expect(
      buildResearchNavigation([source, { ...child, archivedAt: 10 }]).research[0].discussions
    ).toEqual([])
  })

  it('uses one visible row order for numbering and navigation, excluding collapsed children', () => {
    const source = session('source', { importedResearch: { importId: 'a' } })
    const child = session('child', { researchMembership: importedResearchSource(source) })
    const ordinary = session('ordinary')
    const model = buildResearchNavigation([source, child, ordinary])
    const rows = (collapsed: Set<string>): ReturnType<typeof visibleResearchNavigationRows> =>
      visibleResearchNavigationRows(model.research, model.ordinary, collapsed)
    expect(rows(new Set()).map((row) => [row.kind, row.session.id])).toEqual([
      ['research', 'source'],
      ['session', 'child'],
      ['session', 'ordinary']
    ])
    expect(rows(new Set([model.research[0].key])).map((row) => row.session.id)).toEqual([
      'source',
      'ordinary'
    ])
  })
})
