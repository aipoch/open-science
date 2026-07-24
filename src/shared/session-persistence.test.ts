import { describe, expect, it } from 'vitest'

import { MAX_ACP_SESSION_IMAGE_BYTES } from './acp'

import {
  sanitizeActivityGroup,
  normalizeSessionFile,
  sanitizeMessageImages,
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

describe('message image persistence', () => {
  it('keeps only bounded raster images with recomputed byte metadata', () => {
    const images = sanitizeMessageImages([
      { id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 999 },
      { id: 'image-svg', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      { id: 'image-bad', mimeType: 'image/jpeg', data: 'not base64!' }
    ])

    expect(images).toEqual([{ id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }])
  })

  it('caps the number of persisted images in one message', () => {
    const images = sanitizeMessageImages(
      Array.from({ length: 6 }, (_, index) => ({
        id: `image-${index}`,
        mimeType: 'image/webp',
        data: 'AQID'
      }))
    )

    expect(images).toHaveLength(4)
    expect(images?.map((image) => image.id)).toEqual(['image-0', 'image-1', 'image-2', 'image-3'])
  })

  it('round-trips valid message images and drops invalid persisted data', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: '',
          status: 'complete',
          eventIds: ['event-1'],
          images: [
            { id: 'event-1', mimeType: 'image/png', data: 'AQID' },
            { id: 'event-2', mimeType: 'text/html', data: 'AQID' }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0].images).toEqual([
      { id: 'event-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
  })

  it('applies the aggregate session image budget while restoring legacy files', () => {
    const data = 'A'.repeat(4 * 1024 * 1024)
    const bytesPerImage = (data.length * 3) / 4
    const messageCount = MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage + 1
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`,
        role: 'agent',
        content: '',
        images: [{ id: `image-${index}`, mimeType: 'image/png', data }],
        createdAt: index,
        updatedAt: index
      })),
      createdAt: 1,
      updatedAt: 1
    })

    const restoredImages = restored?.messages.flatMap((message) => message.images ?? []) ?? []
    expect(restoredImages).toHaveLength(MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage)
    expect(restoredImages.reduce((total, image) => total + image.byteLength, 0)).toBe(
      MAX_ACP_SESSION_IMAGE_BYTES
    )
  })
})

describe('sanitizeToolActivity', () => {
  it('keeps identity fields and known text/diff content', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      activityGroupId: 'group-1',
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
      activityGroupId: 'group-1',
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

describe('sanitizeActivityGroup', () => {
  it('keeps a valid group declaration bounded and structured', () => {
    expect(
      sanitizeActivityGroup({
        id: 'group-1',
        title: 'Inspect the implementation.',
        sortIndex: 4,
        activityIds: ['tool-1'],
        createdAt: 5,
        updatedAt: 6
      })
    ).toEqual({
      id: 'group-1',
      title: 'Inspect the implementation',
      sortIndex: 4,
      activityIds: ['tool-1'],
      createdAt: 5,
      updatedAt: 6
    })
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

  it('preserves a valid files revision and ignores malformed revisions', () => {
    const current = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: 7
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: -1
    })

    expect(current?.filesRevision).toBe(7)
    expect(malformed?.filesRevision).toBeUndefined()
  })

  it('round-trips the agent backend identity and run model used for diagnostics', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:codex-isolated',
      agentModel: 'gpt-5.6-sol'
    })

    expect(session?.agentFrameworkId).toBe('codex')
    expect(session?.agentBackendId).toBe('codex:codex-isolated')
    expect(session?.agentModel).toBe('gpt-5.6-sol')
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

  it('round-trips the auto-review toggle and defaults older sessions to disabled', () => {
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
    // A corrupt non-boolean value is treated as the safe default (disabled), not preserved.
    const corrupt = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: 'nope'
    })

    expect(disabled?.autoReviewEnabled).toBe(false)
    expect(enabled?.autoReviewEnabled).toBe(true)
    expect(legacy?.autoReviewEnabled).toBe(false)
    expect(corrupt?.autoReviewEnabled).toBe(false)
  })

  it('round-trips enabledComputeHosts and filters out invalid values', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }

    // Valid ssh: prefixed provider ids survive the round-trip.
    const withHosts = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1', 'ssh:gpu-box']
    })
    // Missing field (older sessions written before issue 06) → absent in output.
    const legacy = normalizeSessionFile({ ...base })
    // Non-ssh: strings are filtered out; only valid provider ids survive.
    const mixedValid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:valid', 'not-ssh', '', 42]
    })
    // All invalid → field is absent (not an empty array).
    const allInvalid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['no-prefix', 123]
    })

    expect(withHosts?.enabledComputeHosts).toEqual(['ssh:cluster-1', 'ssh:gpu-box'])
    expect(legacy?.enabledComputeHosts).toBeUndefined()
    expect(mixedValid?.enabledComputeHosts).toEqual(['ssh:valid'])
    expect(allInvalid?.enabledComputeHosts).toBeUndefined()
  })

  it('persists errorReportable only when a model-provider error marked it false', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined, status: 'error' }

    // A provider error tagged non-reportable at the ACP layer round-trips as false so the reloaded
    // session keeps the report button hidden.
    const providerFailure = normalizeSessionFile({
      ...base,
      error: 'Invalid API key',
      errorReportable: false
    })
    // A reportable failure does not persist the field (default is reportable — no need to store true).
    const reportableFailure = normalizeSessionFile({
      ...base,
      error: 'Agent session could not be created.',
      errorReportable: true
    })
    // An older session file, written before the flag existed, has no field and defaults to reportable.
    const legacy = normalizeSessionFile({ ...base, error: 'Some old failure' })
    // The flag is meaningless without an error and is dropped.
    const noError = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      errorReportable: false
    })

    expect(providerFailure?.errorReportable).toBe(false)
    expect(reportableFailure?.errorReportable).toBeUndefined()
    expect(legacy?.errorReportable).toBeUndefined()
    expect(noError?.errorReportable).toBeUndefined()
  })
})
