// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import {
  readResearchProjectDestination,
  rememberResearchProjectDestination,
  resolveResearchProjectDestination
} from './research-project-entry'

const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra
})
const source = session('source', { importedResearch: { importId: 'import-a' } })
const ordinary = session('ordinary', { updatedAt: 2 })

beforeEach(() => localStorage.clear())

describe('research project entry preferences', () => {
  it('preserves ordinary-project most-recent behavior, without storing navigation preferences', () => {
    rememberResearchProjectDestination('project', { kind: 'session', sessionId: 'ordinary' }, [
      ordinary
    ])
    expect(readResearchProjectDestination('project')).toBeUndefined()
    expect(
      resolveResearchProjectDestination('project', [ordinary], { kind: 'draft' })
    ).toBeUndefined()
  })

  it('restores an explicitly visited Session despite newer background activity', () => {
    const destination = { kind: 'session', sessionId: 'ordinary' } as const
    rememberResearchProjectDestination('project', destination, [source, ordinary])
    expect(
      resolveResearchProjectDestination(
        'project',
        [{ ...source, updatedAt: 999 }, ordinary],
        readResearchProjectDestination('project')
      )
    ).toEqual(destination)
  })

  it('preserves exact original identity for both explicit and first-entry destinations', () => {
    expect(resolveResearchProjectDestination('project', [source], undefined)).toEqual({
      kind: 'research',
      sourceSessionId: 'source',
      sourceImportId: 'import-a'
    })
    expect(
      resolveResearchProjectDestination('project', [source], {
        kind: 'session',
        sessionId: 'source',
        sourceImportId: 'import-a'
      })
    ).toEqual({
      kind: 'session',
      sessionId: 'source',
      sourceImportId: 'import-a'
    })
  })

  it('restores an explicit ordinary draft without creating a Session or assigning ownership', () => {
    const sessions = [source, ordinary]
    rememberResearchProjectDestination('project', { kind: 'draft' }, sessions)
    expect(
      resolveResearchProjectDestination(
        'project',
        sessions,
        readResearchProjectDestination('project')
      )
    ).toEqual({ kind: 'draft' })
    expect(sessions).toEqual([source, ordinary])
    expect(ordinary.researchMembership).toBeUndefined()
  })

  it.each([
    { kind: 'session', sessionId: 'deleted' },
    { kind: 'session', sessionId: 'archived' },
    { kind: 'session', sessionId: 'pending' },
    { kind: 'session', sessionId: 'other-project' },
    { kind: 'session', sessionId: 'source', sourceImportId: 'stale-import' },
    { kind: 'research', sourceSessionId: 'source', sourceImportId: 'stale-import' }
  ] as const)('rejects an unavailable remembered destination: %j', (remembered) => {
    const sessions = [
      source,
      ordinary,
      session('archived', { archivedAt: 1, updatedAt: 500 }),
      session('pending', { isPending: true, updatedAt: 500 }),
      session('other-project', { projectId: 'other', updatedAt: 500 })
    ]
    expect(resolveResearchProjectDestination('project', sessions, remembered)).toEqual({
      kind: 'session',
      sessionId: 'ordinary'
    })
  })

  it('ignores corrupt local preferences and refuses implicit ownership from reading or titles', () => {
    localStorage.setItem('open-science:research-project-destination:project', '{bad')
    expect(readResearchProjectDestination('project')).toBeUndefined()
    expect(
      resolveResearchProjectDestination(
        'project',
        [session('import-looking', { title: source.title })],
        undefined
      )
    ).toBeUndefined()
  })
})
