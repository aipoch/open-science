import { describe, expect, it } from 'vitest'

import {
  normalizeSessionFile,
  sanitizeToolActivity,
  type PersistedChatSession
} from './session-persistence'

const createSessionWithActivity = (activity: unknown): Record<string, unknown> => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  activities: [activity],
  createdAt: 1,
  updatedAt: 1
})

const getRestoredActivities = (session: unknown): PersistedChatSession['activities'] =>
  normalizeSessionFile(session)?.activities

describe('sanitizeToolActivity', () => {
  it('keeps identity fields and known text/diff content', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      status: 'completed',
      sortIndex: 3,
      eventIds: ['event-1'],
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }],
      toolContent: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' }
      ],
      createdAt: 5,
      updatedAt: 6
    })

    expect(activity).toMatchObject({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      status: 'completed',
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }]
    })
    // Terminal references carry no payload and are dropped; text/diff entries survive.
    expect(activity?.toolContent).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok' } },
      { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' }
    ])
  })

  it('truncates oversized terminal output', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      terminalOutput: 'x'.repeat(40_000)
    })

    expect(activity?.terminalOutput?.length).toBeLessThan(40_000)
    expect(activity?.terminalOutput?.endsWith('…')).toBe(true)
  })

  it('drops oversized raw payloads while keeping small ones', () => {
    const big = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      rawInput: { filename: 'big.png', content: 'A'.repeat(50_000) }
    })
    const small = sanitizeToolActivity({
      id: 'tool-2',
      status: 'completed',
      rawInput: { command: 'ls -la' }
    })

    expect(big?.rawInput).toBeUndefined()
    expect(small?.rawInput).toEqual({ command: 'ls -la' })
  })

  it('rejects entries without an id', () => {
    expect(sanitizeToolActivity({ status: 'completed' })).toBeUndefined()
  })
})

describe('normalizeSessionFile with activities', () => {
  it('restores a persisted session with its activities intact', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'ls',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        providerToolName: 'Bash',
        toolKind: 'execute',
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities).toEqual([
      expect.objectContaining({ id: 'activity-1', providerToolName: 'Bash', status: 'completed' })
    ])
  })

  it('restores open activities as failed', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'downloading',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]?.status).toBe('failed')
  })

  it('loads sessions that predate persisted activities', () => {
    const session = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Legacy',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })

    expect(session?.activities).toBeUndefined()
    expect(session?.permissionProfile).toBe('ask')
  })

  it('keeps known approval profiles and safely defaults unknown values', () => {
    const full = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'full'
    })
    const unknown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'untrusted-profile'
    })

    expect(full?.permissionProfile).toBe('full')
    expect(unknown?.permissionProfile).toBe('ask')
  })

  it('round-trips the auto-review toggle and defaults older sessions to enabled', () => {
    const disabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: false
    })
    const enabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: true
    })
    // A session file written before the reviewer feature has no field at all.
    const legacy = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined
    })
    // A corrupt non-boolean value is treated as the safe default (enabled), not preserved.
    const corrupt = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: 'nope'
    })

    expect(disabled?.autoReviewEnabled).toBe(false)
    expect(enabled?.autoReviewEnabled).toBe(true)
    expect(legacy?.autoReviewEnabled).toBe(true)
    expect(corrupt?.autoReviewEnabled).toBe(true)
  })
})
