import { afterEach, describe, expect, it } from 'vitest'

import { resolveActiveSessionDisplay, truncateLabel } from './active-session-display'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import type { ActiveSessionInfo } from '../../../shared/storage'

const seedProjects = (projects: { id: string; name: string }[]): void =>
  useProjectStore.setState({ projects: projects as never, isLoaded: true, loadError: undefined })

const seedSessions = (
  sessions: { id: string; projectId?: string; title?: string; cwd?: string }[]
): void => useSessionStore.setState({ sessions: sessions as never, selectedSessionId: undefined })

afterEach(() => {
  seedProjects([])
  seedSessions([])
})

const info = (over: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo => ({
  projectId: 'proj-id',
  sessionId: 's1',
  kind: 'agent',
  ...over
})

describe('resolveActiveSessionDisplay', () => {
  it('resolves the human project name and title from the stores (never the id)', () => {
    seedProjects([{ id: 'p1', name: 'My Analysis' }])
    seedSessions([{ id: 's1', projectId: 'p1', title: 'Fix data loader' }])

    expect(resolveActiveSessionDisplay(info({ projectId: 'p1' }))).toEqual({
      project: 'My Analysis',
      title: 'Fix data loader',
      projectId: 'p1'
    })
  })

  it('resolves the project name via the id main sent when the session is not in the store', () => {
    seedProjects([{ id: 'p1', name: 'My Analysis' }])

    const result = resolveActiveSessionDisplay(
      info({ projectId: 'p1', sessionId: 'gone', title: 'T' })
    )
    expect(result.project).toBe('My Analysis')
    expect(result.title).toBe('T')
    expect(result.projectId).toBe('p1')
  })

  it('falls back to the cwd basename when the project is unknown', () => {
    seedSessions([{ id: 's1', projectId: 'missing', cwd: '/Users/me/work/paper-repro' }])

    expect(resolveActiveSessionDisplay(info({ sessionId: 's1' })).project).toBe('paper-repro')
  })

  it('falls back to the project id then the session id when nothing resolves', () => {
    const result = resolveActiveSessionDisplay(
      info({ projectId: 'raw-id', sessionId: 'raw-session' })
    )
    expect(result.project).toBe('raw-id')
    expect(result.title).toBe('raw-session')
    expect(result.projectId).toBe('raw-id')
  })
})

describe('truncateLabel', () => {
  it('leaves short labels intact', () => {
    expect(truncateLabel('My Analysis')).toBe('My Analysis')
  })

  it('caps long labels at 28 chars with an ellipsis', () => {
    const result = truncateLabel('a'.repeat(40))
    expect(result).toHaveLength(28)
    expect(result.endsWith('…')).toBe(true)
  })
})
