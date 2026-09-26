import { describe, expect, it } from 'vitest'

import { buildTrayNavigationSections, type TrayNavigationSession } from './tray-navigation'

const session = (
  id: string,
  overrides: Partial<{ title: string; updatedAt: number; pinned: boolean }> = {}
): TrayNavigationSession => ({
  id,
  title: overrides.title ?? id,
  projectName: `Project ${id}`,
  updatedAt: overrides.updatedAt ?? 0,
  pinned: overrides.pinned ?? false
})

describe('buildTrayNavigationSections', () => {
  it('prioritizes live sessions and removes them from pinned and recent groups', () => {
    const sections = buildTrayNavigationSections(
      [
        session('running', { updatedAt: 1, pinned: true }),
        session('pinned', { updatedAt: 3, pinned: true }),
        session('recent', { updatedAt: 2 })
      ],
      [{ projectId: 'project-running', sessionId: 'running', kind: 'agent' }]
    )

    expect(sections.map(({ kind, items }) => [kind, items.map(({ id }) => id)])).toEqual([
      ['running', ['running']],
      ['pinned', ['pinned']],
      ['recent', ['recent']]
    ])
  })

  it('sorts each section by update time and limits overflow without dropping it', () => {
    const sections = buildTrayNavigationSections(
      [
        session('old', { updatedAt: 1 }),
        session('new', { updatedAt: 3 }),
        session('middle', { updatedAt: 2 })
      ],
      [],
      2
    )

    expect(sections[0]).toMatchObject({
      kind: 'recent',
      items: [session('new', { updatedAt: 3 }), session('middle', { updatedAt: 2 })],
      overflow: [session('old', { updatedAt: 1 })]
    })
  })

  it('omits sections with no visible sessions and ignores unknown running identities', () => {
    expect(
      buildTrayNavigationSections(
        [session('pinned', { pinned: true })],
        [{ projectId: 'project-missing', sessionId: 'missing', kind: 'notebook' }]
      ).map(({ kind }) => kind)
    ).toEqual(['pinned'])
  })

  it.each(['waiting-for-user', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'excludes %s prompts while preserving independent Notebook execution',
    (presentedStatus) => {
      const waiting = { ...session('waiting'), presentedStatus }
      const agent = { projectId: 'p', sessionId: 'waiting', kind: 'agent' as const }
      expect(buildTrayNavigationSections([waiting], [agent])[0]?.kind).toBe('recent')
      expect(
        buildTrayNavigationSections(
          [waiting, session('notebook')],
          [agent, { projectId: 'p', sessionId: 'notebook', kind: 'notebook' }]
        )[0]?.kind
      ).toBe('running')
    }
  )
})
