import { describe, expect, it, vi } from 'vitest'

import { readOutline } from '../../shared/pptx-edit'
import { createDeckFixture, unzipEntries } from '../../shared/pptx-edit/pptx-fixture.test-support'
import type { ApplicationCallerLease } from '../application-command-router'
import { PptxEditSessionError, PptxEditSessions } from './edit-sessions'

const lease = (): ApplicationCallerLease => ({
  leaseId: 'lease',
  generation: 1,
  signal: new AbortController().signal,
  isCurrent: () => true
})

const identity = { source: 'upload', projectId: 'p', fileId: 'f' } as const

const createHarness = (): {
  sessions: PptxEditSessions
  saveBinaryEdit: ReturnType<typeof vi.fn>
  deck: Uint8Array
} => {
  const deck = createDeckFixture()
  const saveBinaryEdit = vi.fn(async () => ({ kind: 'noop' }) as never)
  const service = {
    openVersion: vi.fn(async () => ({
      size: deck.byteLength,
      logicalFile: { displayName: 'deck.pptx' },
      readRange: async (begin: number, end: number) => deck.slice(begin, end),
      verifyUnchanged: async () => undefined,
      close: async () => undefined
    })),
    saveBinaryEdit
  }
  return { deck, saveBinaryEdit, sessions: new PptxEditSessions(service as never) }
}

const setHello = [
  {
    op: 'setText' as const,
    slideId: 256,
    shapeId: 2,
    paragraphs: [{ runs: [{ text: 'Edited' }] }]
  }
]

describe('PptxEditSessions', () => {
  it('opens a pinned base version and serves it as revision 0', async () => {
    const { sessions } = createHarness()
    const view = await sessions.open(lease(), { ...identity, versionId: 'v1' })
    expect(view).toMatchObject({ basedOnVersionId: 'v1', revision: 0, opCount: 0 })
    expect(view.outline.slides).toHaveLength(3)
    const staged = sessions.openStaged(view.stagedKey)
    expect(staged.path).toBe('deck.pptx')
    expect(staged.size).toBeGreaterThan(0)
  })

  it('replays the full operation list onto the base on every apply', async () => {
    const { sessions } = createHarness()
    const owner = lease()
    const opened = await sessions.open(owner, { ...identity, versionId: 'v1' })
    const first = sessions.apply(owner, { sessionId: opened.sessionId, operations: setHello })
    expect(first.revision).toBe(1)
    expect(first.opCount).toBe(1)
    expect(first.outline.slides[0]!.shapes[0]!.text).toBe('Edited')
    const undone = sessions.apply(owner, { sessionId: opened.sessionId, operations: [] })
    expect(undone.revision).toBe(2)
    expect(undone.outline.slides[0]!.shapes[0]!.text).toBe('Hello')
  })

  it('serves staged bytes for the requested revision only while retained', async () => {
    const { sessions } = createHarness()
    const owner = lease()
    const opened = await sessions.open(owner, { ...identity, versionId: 'v1' })
    for (let i = 0; i < 4; i += 1) {
      sessions.apply(owner, { sessionId: opened.sessionId, operations: setHello })
    }
    expect(() => sessions.openStaged(`${opened.sessionId}:0`)).toThrow(/no longer available/)
    const latest = sessions.openStaged(`${opened.sessionId}:4`)
    const bytes = await latest.readRange(0, latest.size)
    expect(readOutline(bytes).slides[0]!.shapes[0]!.text).toBe('Edited')
    expect(Object.keys(unzipEntries(bytes))).toContain('ppt/presentation.xml')
  })

  it('rejects other callers and unknown sessions', async () => {
    const { sessions } = createHarness()
    const opened = await sessions.open(lease(), { ...identity, versionId: 'v1' })
    expect(() => sessions.apply(lease(), { sessionId: opened.sessionId, operations: [] })).toThrow(
      PptxEditSessionError
    )
    expect(() => sessions.openStaged('missing:0')).toThrow(PptxEditSessionError)
  })

  it('rejects invalid operations without creating a revision', async () => {
    const { sessions } = createHarness()
    const owner = lease()
    const opened = await sessions.open(owner, { ...identity, versionId: 'v1' })
    expect(() =>
      sessions.apply(owner, {
        sessionId: opened.sessionId,
        operations: [{ op: 'deleteShape', slideId: 256, shapeId: 999 }]
      })
    ).toThrow()
    expect(sessions.apply(owner, { sessionId: opened.sessionId, operations: [] }).revision).toBe(1)
  })

  it('saves the replayed result against the pinned base as a user edit', async () => {
    const { sessions, saveBinaryEdit } = createHarness()
    const owner = lease()
    const opened = await sessions.open(owner, { ...identity, versionId: 'v1' })
    await sessions.save(owner, {
      sessionId: opened.sessionId,
      operations: setHello,
      expectedHeadVersionId: 'head-2',
      operationId: 'op-1'
    })
    expect(saveBinaryEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        basedOnVersionId: 'v1',
        expectedHeadVersionId: 'head-2',
        operationId: 'op-1',
        actor: 'user',
        opCount: 1
      })
    )
  })

  it('restores the pinned base unchanged without operations', async () => {
    const { deck, sessions, saveBinaryEdit } = createHarness()
    const owner = lease()
    const opened = await sessions.open(owner, { ...identity, versionId: 'v1' })
    const save = (restore?: boolean): Promise<unknown> =>
      sessions.save(owner, {
        sessionId: opened.sessionId,
        operations: [],
        expectedHeadVersionId: 'head-2',
        operationId: 'op-restore',
        ...(restore ? { restore } : {})
      })
    await expect(save()).rejects.toThrow()
    await save(true)
    expect(saveBinaryEdit).toHaveBeenCalledWith(
      expect.objectContaining({ restore: true, summary: 'restore', opCount: 0, actor: 'user' })
    )
    const [request] = saveBinaryEdit.mock.calls[0] as [{ content: Uint8Array }]
    expect(Buffer.from(request.content).equals(Buffer.from(deck))).toBe(true)
  })

  it('drops sessions on close and when the owner goes away', async () => {
    const { sessions } = createHarness()
    const owner = lease()
    const a = await sessions.open(owner, { ...identity, versionId: 'v1' })
    const b = await sessions.open(owner, { ...identity, versionId: 'v1' })
    sessions.close(owner, a.sessionId)
    expect(() => sessions.openStaged(a.stagedKey)).toThrow()
    sessions.closeOwner(owner)
    expect(() => sessions.openStaged(b.stagedKey)).toThrow()
  })

  it('evicts the oldest session beyond the cap', async () => {
    const { sessions } = createHarness()
    const owner = lease()
    const first = await sessions.open(owner, { ...identity, versionId: 'v1' })
    for (let i = 0; i < 8; i += 1) await sessions.open(owner, { ...identity, versionId: 'v1' })
    expect(() => sessions.openStaged(first.stagedKey)).toThrow()
  })
})
