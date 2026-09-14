import { describe, expect, it } from 'vitest'
import {
  bookmarkApplicationCommandContracts,
  createBookmarkRequestSchema,
  type Bookmark,
  type BookmarkListResult,
  type CreateBookmarkRequest,
  type TextBookmarkTarget
} from './bookmarks'

const request = (): CreateBookmarkRequest & { target: TextBookmarkTarget } => ({
  id: 'bookmark-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  note: '',
  target: {
    kind: 'text',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' },
    quote: ' selected text ',
    anchor: { position: { start: 7, end: 22 } }
  }
})

describe('private bookmark command contract', () => {
  it('rejects whitespace-padded routing identities rather than validating a different session', () => {
    expect(() =>
      bookmarkApplicationCommandContracts.create.args.parse([
        { ...request(), sessionId: ' session-1 ' }
      ])
    ).toThrow()
  })
  it('resolves PDF identity for its owning session without an Agent context binding', () => {
    const input = {
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceKind: 'upload-version',
      sourceFileId: 'file-1',
      versionId: 'version-1'
    }
    expect(bookmarkApplicationCommandContracts.resolvePdfSource.args.parse([input])).toEqual([
      input
    ])
    expect(
      bookmarkApplicationCommandContracts.resolvePdfSource.result.parse({
        ok: false,
        reason: 'source-unavailable'
      })
    ).toEqual({ ok: false, reason: 'source-unavailable' })
  })
  it('preserves the exact selected text and its UTF-16 anchor through command delivery', () => {
    const input = request()
    expect(createBookmarkRequestSchema.parse(input)).toEqual(input)
    expect(bookmarkApplicationCommandContracts.create.args.parse([input])).toEqual([input])
  })
  it('accepts a private PDF area without an Agent image and rejects image-bearing payloads', () => {
    const input = {
      ...request(),
      target: {
        kind: 'pdf',
        source: {
          kind: 'upload-version',
          projectId: 'project-1',
          sessionId: 'session-1',
          sourceFileId: 'file-1',
          versionId: 'version-1',
          checksum: 'a'.repeat(64),
          name: 'paper.pdf',
          path: 'upload://version-1'
        },
        selector: {
          kind: 'region',
          pageNumber: 2,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          pageRotation: 90,
          coordinateVersion: 1
        }
      }
    }
    expect(createBookmarkRequestSchema.safeParse(input).success).toBe(true)
    expect(
      createBookmarkRequestSchema.safeParse({
        ...input,
        target: {
          ...input.target,
          selector: { ...input.target.selector, image: { data: 'unexpected' } }
        }
      }).success
    ).toBe(false)
  })
  it('rejects invalid anchors and unknown routing fields without rewriting user input', () => {
    const input = request()
    expect(
      createBookmarkRequestSchema.safeParse({ ...input, branchId: 'ignored-branch' }).success
    ).toBe(false)
    expect(
      createBookmarkRequestSchema.safeParse({
        ...input,
        target: { ...input.target, anchor: { position: { start: 7, end: 8 } } }
      }).success
    ).toBe(false)
    expect(
      createBookmarkRequestSchema.safeParse({ ...input, note: 'x'.repeat(2001) }).success
    ).toBe(false)
  })
  it('bounds each delivered page without applying the composer annotation count limit', () => {
    const item: Bookmark = {
      ...request(),
      version: 1,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    }
    const page = (count: number): BookmarkListResult => ({
      items: Array.from({ length: count }, (_, index) => ({ ...item, id: `bookmark-${index}` })),
      total: count
    })
    expect(() => bookmarkApplicationCommandContracts.list.result.parse(page(20))).not.toThrow()
    expect(() => bookmarkApplicationCommandContracts.list.result.parse(page(101))).toThrow()
  })
})
