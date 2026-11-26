import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { marked } from 'marked'
import {
  MAX_SYNTHESIS_NOTE_BYTES,
  literatureSynthesisResultSchema,
  synthesisCandidateSchema,
  type SynthesisCandidate,
  type SynthesisNote,
  type LiteratureSynthesisRequest,
  type SynthesisExcerptSelection
} from '../../shared/literature-synthesis'
import { beginMigration, endMigration } from '../storage/migration-state'
import { LiteratureSynthesisStore } from './synthesis-store'
import { LiteratureSynthesisService, exportSynthesisMarkdown } from './synthesis'

const roots: string[] = []
afterEach(async () => {
  endMigration()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const candidate = (): SynthesisCandidate =>
  synthesisCandidateSchema.parse({
    itemId: 'paper',
    versionId: 'version',
    annotationId: 'annotation',
    bibliography: {
      itemId: 'paper',
      title: 'Paper <img src=x>',
      authors: 'A [B]',
      year: '2024',
      doi: '10.1/example'
    },
    tags: [{ id: 'tag', name: 'Methods' }],
    annotation: {
      version: 1,
      id: 'annotation',
      literatureVersionId: 'version',
      kind: 'highlight',
      origin: 'user',
      tagIds: ['tag'],
      note: 'My annotation',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      target: {
        source: {
          kind: 'literature-attachment-version',
          sourceFileId: 'attachment',
          versionId: 'version',
          checksum: 'a'.repeat(64),
          name: 'paper.pdf',
          path: 'private/path.pdf'
        },
        selector: {
          kind: 'text',
          pageNumber: 3,
          pageRotation: 0,
          coordinateVersion: 1,
          exact: 'Original *quote*\n<script>x</script>',
          position: { start: 0, end: 'Original *quote*\n<script>x</script>'.length },
          quads: [{ x: 0, y: 0, width: 0.2, height: 0.1 }],
          extractorVersion: 'test'
        }
      }
    }
  })
async function fixture(): Promise<{
  path: string
  root: string
  sources: {
    canonicalIds: ReturnType<typeof vi.fn<(ids: string[]) => Promise<Map<string, string>>>>
    candidates: ReturnType<typeof vi.fn<() => Promise<{ candidates: SynthesisCandidate[] }>>>
    resolve: ReturnType<
      typeof vi.fn<
        (selection: SynthesisExcerptSelection) => Promise<SynthesisCandidate | undefined>
      >
    >
  }
  service: LiteratureSynthesisService
  create(title?: string): Promise<SynthesisNote>
  setSource(value: SynthesisCandidate | undefined): void
}> {
  const root = await mkdtemp(join(tmpdir(), 'literature-synthesis-'))
  roots.push(root)
  const path = join(root, 'literature', 'synthesis-v1.json')
  let source: SynthesisCandidate | undefined = candidate()
  const sources = {
    canonicalIds: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, id]))),
    candidates: vi.fn(async () => ({ candidates: source ? [structuredClone(source)] : [] })),
    resolve: vi.fn(async () => (source ? structuredClone(source) : undefined))
  }
  const service = new LiteratureSynthesisService(new LiteratureSynthesisStore(() => path), sources)
  const create = async (title = 'Synthesis'): Promise<SynthesisNote> => {
    const result = await service.run({
      action: 'create',
      title,
      itemIds: ['paper'],
      excerpts: [
        {
          itemId: 'paper',
          versionId: 'version',
          annotationId: 'annotation',
          expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
    if (result.action !== 'create') throw new Error('Unexpected result')
    return result.note
  }
  return {
    path,
    root,
    sources,
    service,
    create,
    setSource(value: SynthesisCandidate | undefined) {
      source = value
    }
  }
}

describe('literature synthesis persistence and provenance', () => {
  it('reads the durable revision of a 199-excerpt note without resolving any sources', async () => {
    const f = await fixture()
    const baseline = await f.create()
    const blocks = Array.from({ length: 199 }, (_, index) => ({
      type: 'excerpt',
      id: `excerpt-${index}`,
      snapshot: candidate()
    }))
    await writeFile(
      f.path,
      JSON.stringify({ version: 1, notes: [{ ...baseline, revision: 7, blocks }] })
    )
    f.sources.resolve.mockClear()
    f.sources.canonicalIds.mockClear()
    f.sources.candidates.mockClear()
    const result = literatureSynthesisResultSchema.parse(
      await f.service.run({ action: 'revision', noteId: baseline.id })
    )
    expect(result).toEqual({ action: 'revision', noteId: baseline.id, revision: 7 })
    expect(f.sources.resolve).not.toHaveBeenCalled()
    expect(f.sources.canonicalIds).not.toHaveBeenCalled()
    expect(f.sources.candidates).not.toHaveBeenCalled()

    // Compare the previous pre-read path against the same near-limit durable note.
    await f.service.run({ action: 'read', noteId: baseline.id })
    expect(f.sources.resolve).toHaveBeenCalledTimes(199)
    await expect(f.service.run({ action: 'revision', noteId: 'missing-note' })).rejects.toThrow(
      'Synthesis note not found.'
    )
  })

  it('lists a near-limit durable library without duplicating source metadata beyond the transport limit', async () => {
    const f = await fixture()
    const baseline = await f.create()
    const snapshot = candidate()
    snapshot.bibliography.authors = 'Researcher '.repeat(170_000)
    const notes = Array.from({ length: 8 }, (_, index) => ({
      ...baseline,
      id: `large-note-${index}`,
      blocks: [{ type: 'excerpt', id: 'excerpt', snapshot }]
    }))
    const stored = JSON.stringify({ version: 1, notes })
    expect(Buffer.byteLength(stored)).toBeLessThan(16 * 1024 * 1024)
    expect(Buffer.byteLength(stored)).toBeGreaterThan(14 * 1024 * 1024)
    await writeFile(f.path, stored)
    const result = literatureSynthesisResultSchema.parse(await f.service.run({ action: 'list' }))
    if (result.action !== 'list') throw new Error('Unexpected result')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(Buffer.byteLength(stored))
    expect(result.notes).toHaveLength(8)
    expect(result.notes[0]).not.toHaveProperty('blocks')
    expect(result.notes[0]?.searchText).not.toContain('Researcher')
    expect(result.notes[0]?.sourceMetadata?.[0].authors).toBe(snapshot.bibliography.authors)
  })

  it('derives list search text from saved paper metadata and tags', async () => {
    const f = await fixture()
    await f.create()

    const listed = await f.service.run({ action: 'list' })
    expect(listed.action).toBe('list')
    if (listed.action !== 'list') throw new Error('Unexpected result')
    expect(listed.notes[0]?.sourceMetadata?.[0].title).toBe('Paper <img src=x>')
    expect(listed.notes[0]?.sourceMetadata?.[0].authors).toBe('A [B]')
    expect(listed.notes[0]?.sourceMetadata?.[0].tags).toContain('Methods')
  })

  it('returns deduplicated source metadata with merged tags in list summaries', async () => {
    const f = await fixture()
    const note = await f.create()
    const duplicate = candidate()
    duplicate.annotationId = 'annotation-2'
    duplicate.annotation.id = 'annotation-2'
    duplicate.tags = [{ id: 'evidence', name: 'Evidence' }]
    f.setSource(duplicate)
    const appended = await f.service.run({
      action: 'append',
      noteId: note.id,
      expectedRevision: note.revision,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation-2' }]
    })
    expect(appended.action).toBe('append')

    const listed = await f.service.run({ action: 'list' })
    expect(listed.action).toBe('list')
    if (listed.action !== 'list') throw new Error('Unexpected result')
    expect(listed.notes[0]?.sourceMetadata).toEqual([
      { title: 'Paper <img src=x>', authors: 'A [B]', tags: ['Methods', 'Evidence'] }
    ])
  })

  it('rejects exporting a revision the current viewer has not reviewed', async () => {
    const f = await fixture()
    const visible = await f.create()
    const otherWriter = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const updated = await otherWriter.run({
      action: 'update',
      noteId: visible.id,
      expectedRevision: visible.revision,
      title: 'Other writer revision two',
      blocks: [{ id: 'new-author-text', type: 'text', text: 'Unreviewed replacement content' }]
    })
    if (updated.action !== 'update') throw new Error('Unexpected result')
    await expect(
      f.service.run({ action: 'export', noteId: visible.id, expectedRevision: visible.revision })
    ).rejects.toThrow('changed')
    const exported = await f.service.run({
      action: 'export',
      noteId: visible.id,
      expectedRevision: updated.note.revision
    })
    expect(exported.action === 'export' && exported.markdown).toContain(
      'Unreviewed replacement content'
    )
  })

  it('rejects an update that lands while export source enrichment is in flight', async () => {
    const f = await fixture()
    const note = await f.create()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.sources.resolve.mockImplementationOnce(async () => {
      await blocked
      return candidate()
    })
    const exporting = f.service.run({
      action: 'export',
      noteId: note.id,
      expectedRevision: note.revision
    })
    await vi.waitFor(() => expect(f.sources.resolve).toHaveBeenCalledTimes(2))
    const updated = await f.service.run({
      action: 'update',
      noteId: note.id,
      expectedRevision: note.revision,
      title: 'Changed during export',
      blocks: [{ id: 'text', type: 'text', text: 'new content' }]
    })
    expect(updated.action).toBe('update')
    release()
    await expect(exporting).rejects.toThrow('changed')
  })

  it('canonicalizes and deduplicates aliases when creating excerpts', async () => {
    const f = await fixture()
    f.sources.canonicalIds.mockImplementation(
      async (ids) => new Map(ids.map((id) => [id, id === 'alias' ? 'annotation' : id]))
    )
    f.sources.resolve.mockImplementation(async (selection) => {
      const value = candidate()
      value.annotationId = selection.annotationId
      value.annotation.id = selection.annotationId
      return value
    })
    const result = await f.service.run({
      action: 'create',
      title: 'Alias safe',
      itemIds: ['paper'],
      excerpts: [
        { itemId: 'paper', versionId: 'version', annotationId: 'alias' },
        { itemId: 'paper', versionId: 'version', annotationId: 'annotation' }
      ]
    })
    expect(result.action === 'create' && result.note.blocks).toHaveLength(1)
  })

  it('counts canonical additions at capacity and rejects overflow without changing durable data', async () => {
    const f = await fixture()
    const note = await f.create()
    const stored = {
      ...note,
      blocks: [
        { type: 'excerpt', id: 'retired-block', snapshot: candidate() },
        ...Array.from({ length: 198 }, (_, index) => ({
          type: 'text',
          id: `reasoning-${index}`,
          text: 'Preserved reasoning'
        }))
      ]
    }
    await writeFile(f.path, JSON.stringify({ version: 1, notes: [stored] }))
    f.sources.canonicalIds.mockImplementation(
      async (ids) =>
        new Map(ids.map((id) => [id, id === 'annotation' ? 'retained-annotation' : id]))
    )
    f.sources.resolve.mockImplementation(async ({ annotationId }) => {
      const value = candidate()
      value.annotationId = annotationId
      value.annotation.id = annotationId
      return value
    })
    const request = {
      action: 'append' as const,
      requestId: 'fits-after-alias-dedup',
      noteId: note.id,
      expectedRevision: note.revision,
      itemIds: ['paper'],
      excerpts: ['retained-annotation', 'new-annotation'].map((annotationId) => ({
        itemId: 'paper',
        versionId: 'version',
        annotationId
      }))
    }
    const appended = await f.service.run(request)
    if (appended.action !== 'append') throw new Error('Expected canonical append to fit')
    expect(appended.note.blocks).toHaveLength(200)
    expect(appended.note.blocks[0]).toMatchObject({ snapshot: { annotationId: 'annotation' } })
    expect(appended.note.blocks.at(-1)).toMatchObject({
      snapshot: { annotationId: 'new-annotation' }
    })
    expect(appended.note.revision).toBe(2)
    const before = await readFile(f.path, 'utf8')
    const rejected = literatureSynthesisResultSchema.parse(
      await f.service.run({
        ...request,
        requestId: 'capacity-rejected',
        expectedRevision: 2,
        excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'one-too-many' }]
      })
    )
    expect(rejected).toEqual({ action: 'append-rejected', reason: 'block-limit', maxBlocks: 200 })
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('retries a deleted note idempotently after the first response is lost', async () => {
    const f = await fixture()
    const note = await f.create()
    const request = {
      action: 'delete' as const,
      requestId: 'delete-1',
      noteId: note.id,
      expectedRevision: note.revision
    }
    const deleted = { action: 'delete', deleted: true }
    await expect(Promise.all([f.service.run(request), f.service.run(request)])).resolves.toEqual([
      deleted,
      deleted
    ])
    await expect(
      f.service.run({ ...request, expectedRevision: note.revision + 1 })
    ).rejects.toThrow('different content')
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    await expect(restarted.run(request)).resolves.toEqual({ action: 'delete', deleted: true })
    await expect(f.service.run(request)).resolves.toEqual({ action: 'delete', deleted: true })
    await expect(f.service.run({ ...request, requestId: 'delete-2' })).rejects.toThrow('changed')
  })

  it('persists a receipt when the notes array itself is unchanged', async () => {
    const f = await fixture()
    const store = new LiteratureSynthesisStore(() => f.path)
    const receipt = { id: 'receipt-only', fingerprint: 'a'.repeat(64) }
    await store.run((_notes, deletedMutations) => ({
      result: undefined,
      deletedMutations: [...deletedMutations, receipt]
    }))
    const restarted = new LiteratureSynthesisStore(() => f.path)
    await expect(
      restarted.run((_notes, deletedMutations) => ({ result: deletedMutations }))
    ).resolves.toEqual([receipt])
  })

  it('exports a legal near-limit note after entity escaping expands its content', async () => {
    const f = await fixture()
    const note = await f.create()
    const saved = await f.service.run({
      action: 'update',
      noteId: note.id,
      expectedRevision: note.revision,
      title: 'Escaped author text',
      blocks: Array.from({ length: 104 }, (_, index) => ({
        id: `text-${index}`,
        type: 'text' as const,
        text: '&'.repeat(20000)
      }))
    })
    if (saved.action !== 'update') throw new Error('Unexpected result')
    expect(Buffer.byteLength(JSON.stringify(saved.note))).toBeLessThan(MAX_SYNTHESIS_NOTE_BYTES)
    const exported = await f.service.run({
      action: 'export',
      noteId: saved.note.id,
      expectedRevision: saved.note.revision
    })
    if (exported.action !== 'export') throw new Error('Unexpected result')
    expect(exported.markdown.length).toBeGreaterThan(8_000_000)
    expect(literatureSynthesisResultSchema.safeParse(exported).success).toBe(true)
    expect(exported.markdown.endsWith('&amp;\n')).toBe(true)
  })

  it.each([false, true])(
    'replays a committed create after response loss without creating a duplicate (source removed: %s)',
    async (removeSource) => {
      const f = await fixture()
      const request: LiteratureSynthesisRequest = {
        action: 'create',
        requestId: 'create-1',
        title: 'Recoverable',
        itemIds: ['paper'],
        excerpts: [
          {
            itemId: 'paper',
            versionId: 'version',
            annotationId: 'annotation',
            expectedUpdatedAt: candidate().annotation.updatedAt
          }
        ]
      }
      const loseResponse = async (): Promise<void> => {
        await f.service.run(request)
        throw new Error('transport lost')
      }
      await expect(loseResponse()).rejects.toThrow('transport lost')
      if (removeSource) f.setSource(undefined)
      const restarted = new LiteratureSynthesisService(
        new LiteratureSynthesisStore(() => f.path),
        f.sources
      )
      const retried = await restarted.run(request)
      expect(retried.action === 'create' && retried.note).toMatchObject({
        revision: 1,
        creationRequest: { id: 'create-1' },
        lastMutation: { id: 'create-1' }
      })
      const listed = await restarted.run({ action: 'list' })
      expect(listed.action === 'list' && listed.notes).toHaveLength(1)
      await expect(restarted.run({ ...request, title: 'Changed payload' })).rejects.toThrow(
        'different content'
      )
    }
  )

  it('replays an update after response loss while rejecting reused IDs with changed author text', async () => {
    const f = await fixture()
    const note = await f.create()
    const request: LiteratureSynthesisRequest = {
      action: 'update',
      requestId: 'update-1',
      noteId: note.id,
      expectedRevision: 1,
      title: 'Saved',
      blocks: [
        { id: 'author', type: 'text', text: 'Saved author text' },
        { id: note.blocks[0].id, type: 'excerpt' }
      ]
    }
    await expect(
      (async () => {
        await f.service.run(request)
        throw new Error('transport lost')
      })()
    ).rejects.toThrow('transport lost')
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const retried = await restarted.run(request)
    expect(retried.action === 'update' && retried.note).toMatchObject({
      title: 'Saved',
      revision: 2,
      lastMutation: { id: 'update-1' }
    })
    await expect(
      restarted.run({
        ...request,
        blocks: [{ id: 'author', type: 'text', text: 'Different author text' }]
      })
    ).rejects.toThrow('different content')
    await restarted.run({
      action: 'update',
      requestId: 'other-editor',
      noteId: note.id,
      expectedRevision: 2,
      title: 'Later edit',
      blocks: []
    })
    await expect(restarted.run(request)).rejects.toThrow('changed')
    const read = await restarted.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note).toMatchObject({ title: 'Later edit', revision: 3 })
  })

  it('replays an append after response loss without adding the excerpt twice', async () => {
    const f = await fixture()
    const note = await f.create()
    const next = candidate()
    next.annotationId = 'annotation-2'
    next.annotation.id = 'annotation-2'
    f.setSource(next)
    const request: LiteratureSynthesisRequest = {
      action: 'append',
      requestId: 'append-1',
      noteId: note.id,
      expectedRevision: 1,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation-2' }]
    }
    await expect(
      (async () => {
        await f.service.run(request)
        throw new Error('transport lost')
      })()
    ).rejects.toThrow('transport lost')
    f.setSource(undefined)
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const retried = await restarted.run(request)
    expect(retried.action === 'append' && retried.note.revision).toBe(2)
    expect(retried.action === 'append' && retried.note.blocks).toHaveLength(2)
  })

  it('returns the current note for an older create receipt without overwriting later edits', async () => {
    const f = await fixture()
    const create: LiteratureSynthesisRequest = {
      action: 'create',
      requestId: 'create-2',
      title: 'Original',
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation' }]
    }
    const result = await f.service.run(create)
    if (result.action !== 'create') throw new Error('Unexpected create result')
    await f.service.run({
      action: 'update',
      requestId: 'later-edit',
      noteId: result.note.id,
      expectedRevision: 1,
      title: 'Later concurrent edit',
      blocks: []
    })
    const retried = await f.service.run(create)
    expect(retried.action === 'create' && retried.note).toMatchObject({
      title: 'Later concurrent edit',
      revision: 2,
      lastMutation: { id: 'later-edit' }
    })
  })

  it('persists ordered edits and reads them after restart; concurrent revisions cannot overwrite', async () => {
    const f = await fixture()
    const note = await f.create()
    const excerpt = note.blocks[0]
    const update = {
      action: 'update' as const,
      noteId: note.id,
      expectedRevision: 1,
      title: 'Edited',
      blocks: [
        { type: 'heading' as const, id: 'heading', text: 'Evidence', level: 2 as const },
        { type: 'text' as const, id: 'text', text: 'My synthesis' },
        { type: 'excerpt' as const, id: excerpt.id }
      ]
    }
    const other = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const results = await Promise.allSettled([f.service.run(update), other.run(update)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const read = await restarted.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks.map((block) => block.type)).toEqual([
      'heading',
      'text',
      'excerpt'
    ])
    expect(read.action === 'read' && read.note.revision).toBe(2)
  })

  it('keeps canonical duplicate appends without a request identity entirely unchanged', async () => {
    const f = await fixture()
    const note = await f.create()
    f.sources.canonicalIds.mockImplementation(
      async (ids) => new Map(ids.map((id) => [id, 'annotation']))
    )
    f.sources.resolve.mockImplementation(async ({ annotationId }) => {
      const value = candidate()
      value.annotationId = annotationId
      value.annotation.id = annotationId
      return value
    })
    const before = await readFile(f.path, 'utf8')
    const appended = await f.service.run({
      action: 'append',
      noteId: note.id,
      expectedRevision: note.revision,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'shared-alias' }]
    })
    expect(appended.action === 'append' && appended.note).toMatchObject({
      revision: note.revision,
      updatedAt: note.updatedAt,
      blocks: note.blocks
    })
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('replays a no-op append independently of the last real write receipt without conflicting with another editor', async () => {
    const f = await fixture()
    const initial = await f.create()
    const save = {
      action: 'update' as const,
      requestId: 'last-real-save',
      noteId: initial.id,
      expectedRevision: initial.revision,
      title: 'Saved while response was lost',
      blocks: [
        { type: 'excerpt' as const, id: initial.blocks[0].id },
        { type: 'text' as const, id: 'reasoning', text: 'Saved reasoning' }
      ]
    }
    const saved = await f.service.run(save)
    if (saved.action !== 'update') throw new Error('Unexpected result')
    const append = {
      action: 'append' as const,
      requestId: 'duplicate-noop',
      noteId: initial.id,
      expectedRevision: saved.note.revision,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation' }]
    }
    const appended = await f.service.run(append)
    expect(appended.action === 'append' && appended.note).toMatchObject({
      revision: saved.note.revision,
      updatedAt: saved.note.updatedAt,
      blocks: saved.note.blocks,
      lastMutation: saved.note.lastMutation,
      lastNoopAppend: { id: append.requestId }
    })
    f.setSource(undefined)
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const recoveredSave = await restarted.run(save)
    expect(recoveredSave.action === 'update' && recoveredSave.note).toMatchObject({
      revision: saved.note.revision,
      updatedAt: saved.note.updatedAt,
      lastMutation: { id: save.requestId },
      lastNoopAppend: { id: append.requestId }
    })
    const recoveredAppend = await restarted.run(append)
    expect(recoveredAppend.action === 'append' && recoveredAppend.note).toMatchObject({
      revision: saved.note.revision,
      updatedAt: saved.note.updatedAt,
      lastMutation: { id: save.requestId },
      lastNoopAppend: { id: append.requestId }
    })
    await expect(
      restarted.run({
        ...append,
        excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'different-content' }]
      })
    ).rejects.toThrow('different content')
    const otherEditor = await restarted.run({
      ...save,
      requestId: 'another-editor',
      expectedRevision: saved.note.revision,
      title: 'Another window can still save',
      blocks: save.blocks
    })
    expect(otherEditor.action === 'update' && otherEditor.note).toMatchObject({
      revision: saved.note.revision + 1,
      title: 'Another window can still save'
    })
    const laterReplay = await restarted.run(append)
    expect(laterReplay.action === 'append' && laterReplay.note).toMatchObject({
      revision: saved.note.revision + 1,
      title: 'Another window can still save',
      lastMutation: { id: 'another-editor' }
    })
    const listed = await restarted.run({ action: 'list' })
    expect(listed.action === 'list' && listed.notes[0]).not.toHaveProperty('lastNoopAppend')
  })

  it('appends only new annotation identities and preserves authored blocks', async () => {
    const f = await fixture()
    const note = await f.create()
    await f.service.run({
      action: 'update',
      noteId: note.id,
      expectedRevision: 1,
      title: note.title,
      blocks: [
        { type: 'text', id: 'author', text: 'My synthesis' },
        { type: 'excerpt', id: note.blocks[0].id }
      ]
    })
    const appended = await f.service.run({
      action: 'append',
      noteId: note.id,
      expectedRevision: 2,
      itemIds: ['paper'],
      excerpts: [
        {
          itemId: 'paper',
          versionId: 'version',
          annotationId: 'annotation',
          expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
    expect(appended.action === 'append' && appended.note.blocks.map((block) => block.type)).toEqual(
      ['text', 'excerpt']
    )
    expect(appended.action === 'append' && appended.note.revision).toBe(2)
    f.sources.resolve.mockRejectedValueOnce(new Error('temporary read failure'))
    const saved = await f.service.run({
      action: 'update',
      noteId: note.id,
      expectedRevision: 2,
      title: 'Saved independently',
      blocks: [
        { type: 'text', id: 'author', text: 'My synthesis' },
        { type: 'excerpt', id: note.blocks[0].id }
      ]
    })
    expect(saved.action === 'update' && saved.note.title).toBe('Saved independently')
  })

  it('normalizes optional source fields after JSON restart when checking revisions', async () => {
    const f = await fixture()
    const source = candidate()
    source.annotation.projectId = undefined
    f.setSource(source)
    const note = await f.create()
    const read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({ sourceStatus: 'current' })
  })

  it.each(['current', 'changed', 'unavailable', 'unverified'] as const)(
    'checks only the requested excerpt source and keeps its durable snapshot (%s)',
    async (status) => {
      const f = await fixture()
      const note = await f.create()
      const selected = note.blocks[0]
      if (selected.type !== 'excerpt') throw new Error('Expected excerpt')
      const contents = JSON.stringify({
        version: 1,
        notes: [
          {
            ...note,
            blocks: [
              selected,
              ...Array.from({ length: 199 }, (_, index) => ({
                ...selected,
                id: `other-excerpt-${index}`
              }))
            ]
          }
        ]
      })
      await writeFile(f.path, contents)
      if (status === 'changed') {
        const edited = candidate()
        edited.annotation.note = 'Changed live annotation'
        f.setSource(edited)
      } else if (status === 'unavailable') f.setSource(undefined)
      else if (status === 'unverified')
        f.sources.resolve.mockRejectedValue(new Error('Source temporarily unavailable'))
      f.sources.resolve.mockClear()
      const source = literatureSynthesisResultSchema.parse(
        await f.service.run({
          action: 'source',
          noteId: note.id,
          blockId: selected.id
        })
      )
      expect(source).toEqual({ action: 'source', block: { ...selected, sourceStatus: status } })
      expect(f.sources.resolve).toHaveBeenCalledExactlyOnceWith({
        itemId: 'paper',
        versionId: 'version',
        annotationId: 'annotation'
      })
      expect(await readFile(f.path, 'utf8')).toBe(contents)
    }
  )

  it('compares tag identities and names independently of tag order in a saved snapshot', async () => {
    const f = await fixture()
    const original = candidate()
    original.tags.push({ id: 'second', name: 'Follow-up' })
    original.annotation.tagIds.push('second')
    f.setSource(original)
    const note = await f.create()
    const request = { action: 'source' as const, noteId: note.id, blockId: note.blocks[0].id }
    const reordered = structuredClone(original)
    reordered.tags.reverse()
    reordered.annotation.tagIds.reverse()
    f.setSource(reordered)
    await expect(f.service.run(request)).resolves.toMatchObject({
      block: { sourceStatus: 'current', snapshot: { tags: original.tags } }
    })
    reordered.tags[0].name = 'Later visits'
    await expect(f.service.run(request)).resolves.toMatchObject({
      block: { sourceStatus: 'changed' }
    })
    reordered.tags.shift()
    reordered.annotation.tagIds.shift()
    await expect(f.service.run(request)).resolves.toMatchObject({
      block: { sourceStatus: 'changed' }
    })
  })

  it('rejects unknown notes, blocks owned by another note, and authored blocks before checking a source', async () => {
    const f = await fixture()
    const note = await f.create()
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        notes: [
          {
            ...note,
            blocks: [...note.blocks, { type: 'text', id: 'reasoning', text: 'My own reasoning' }]
          },
          { ...note, id: 'other-note', blocks: [{ ...note.blocks[0], id: 'other-excerpt' }] }
        ]
      })
    )
    f.sources.resolve.mockClear()
    for (const [noteId, blockId] of [
      ['unknown-note', note.blocks[0].id],
      [note.id, 'unknown-block'],
      [note.id, 'other-excerpt'],
      [note.id, 'reasoning']
    ])
      await expect(f.service.run({ action: 'source', noteId, blockId })).rejects.toThrow(
        'Synthesis excerpt not found.'
      )
    await expect(
      f.service.run({ action: 'source', noteId: ' ', blockId: note.blocks[0].id })
    ).rejects.toThrow()
    expect(f.sources.resolve).not.toHaveBeenCalled()
  })

  it('keeps immutable snapshot when the source is edited or deleted', async () => {
    const f = await fixture()
    const note = await f.create()
    const edited = candidate()
    edited.annotation.note = 'Edited source note'
    edited.annotation.updatedAt = '2026-02-01T00:00:00.000Z'
    f.setSource(edited)
    let read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({
      sourceStatus: 'changed',
      snapshot: { annotation: { note: 'My annotation' } }
    })
    f.setSource(undefined)
    read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({
      sourceStatus: 'unavailable',
      snapshot: { annotation: { note: 'My annotation' } }
    })
  })

  it('reads and exports durable snapshots when source status cannot be checked', async () => {
    const f = await fixture()
    const note = await f.create()
    const before = await readFile(f.path, 'utf8')
    f.sources.resolve.mockRejectedValue(new Error('source database unavailable'))
    const read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({
      sourceStatus: 'unverified',
      snapshot: { annotation: { note: 'My annotation' } }
    })
    const exported = await f.service.run({
      action: 'export',
      noteId: note.id,
      expectedRevision: note.revision
    })
    expect(exported.action === 'export' && exported.markdown).toContain('status: unverified')
    expect(exported.action === 'export' && exported.markdown).toContain('Original')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    // New selections still require an authoritative source; only status enrichment is optional.
    await expect(f.create()).rejects.toThrow('source database unavailable')
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('isolates a failed source check from other excerpts in the same note', async () => {
    const f = await fixture()
    const note = await f.create()
    const next = candidate()
    next.annotationId = 'annotation-2'
    next.annotation.id = 'annotation-2'
    f.setSource(next)
    await f.service.run({
      action: 'append',
      noteId: note.id,
      expectedRevision: 1,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation-2' }]
    })
    f.sources.resolve
      .mockRejectedValueOnce(new Error('first source check failed'))
      .mockResolvedValueOnce(next)
    const read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks).toMatchObject([
      { sourceStatus: 'unverified' },
      { sourceStatus: 'current' }
    ])
  })

  it('derives source status after author saves and receipt replays instead of restoring old status', async () => {
    const f = await fixture()
    const note = await f.create()
    f.setSource(undefined)
    const read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({
      sourceStatus: 'unavailable'
    })
    const request: LiteratureSynthesisRequest = {
      action: 'update',
      requestId: 'checked-save',
      noteId: note.id,
      expectedRevision: 1,
      title: 'Author edit',
      blocks: [{ type: 'excerpt', id: note.blocks[0].id }]
    }
    const saved = await f.service.run(request)
    expect(saved.action === 'update' && saved.note.blocks[0]).toMatchObject({
      sourceStatus: 'unavailable'
    })
    const edited = candidate()
    edited.annotation.note = 'Later source text'
    f.setSource(edited)
    const replayed = await f.service.run(request)
    expect(replayed.action === 'update' && replayed.note).toMatchObject({
      revision: 2,
      blocks: [{ sourceStatus: 'changed', snapshot: { annotation: { note: 'My annotation' } } }]
    })
    expect(await readFile(f.path, 'utf8')).not.toContain('sourceStatus')
  })

  it('keeps successful mutations and receipt replays successful when post-write source checks fail', async () => {
    const f = await fixture()
    const note = await f.create()
    f.sources.resolve.mockRejectedValue(new Error('source check failure'))
    const request: LiteratureSynthesisRequest = {
      action: 'update',
      requestId: 'durable-save',
      noteId: note.id,
      expectedRevision: 1,
      title: 'Committed author edit',
      blocks: [{ type: 'excerpt', id: note.blocks[0].id }]
    }
    const saved = await f.service.run(request)
    expect(saved.action === 'update' && saved.note).toMatchObject({
      revision: 2,
      title: 'Committed author edit',
      blocks: [{ sourceStatus: 'unverified' }]
    })
    const durable = await readFile(f.path, 'utf8')
    expect(JSON.parse(durable).notes[0]).toMatchObject({
      revision: 2,
      title: 'Committed author edit'
    })
    const replayed = await f.service.run(request)
    expect(replayed).toEqual(saved)
    expect(await readFile(f.path, 'utf8')).toBe(durable)
  })

  it('accepts legacy version-1 source statuses but omits them from subsequent durable writes', async () => {
    const f = await fixture()
    const legacy = await f.create()
    await writeFile(f.path, JSON.stringify({ version: 1, notes: [legacy] }))
    f.setSource(undefined)
    const restarted = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path),
      f.sources
    )
    const listed = await restarted.run({ action: 'list' })
    expect(listed.action === 'list' && listed.notes[0]?.sourceMetadata?.[0].title).toBe(
      'Paper <img src=x>'
    )
    const read = await restarted.run({ action: 'read', noteId: legacy.id })
    expect(read.action === 'read' && read.note.blocks[0]).toMatchObject({
      sourceStatus: 'unavailable'
    })
    await restarted.run({
      action: 'update',
      noteId: legacy.id,
      expectedRevision: 1,
      title: legacy.title,
      blocks: [{ type: 'excerpt', id: legacy.blocks[0].id }]
    })
    const durable = JSON.parse(await readFile(f.path, 'utf8'))
    expect(durable.version).toBe(1)
    expect(durable.notes[0].blocks[0]).not.toHaveProperty('sourceStatus')
    expect(durable.notes[0].blocks[0].snapshot).toEqual(
      legacy.blocks[0].type === 'excerpt' && legacy.blocks[0].snapshot
    )
  })

  it('still rejects storage read failures instead of reporting unverified source status', async () => {
    const f = await fixture()
    const note = await f.create()
    const broken = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path, {
        readFileWithinLimit: async () => {
          throw new Error('storage unavailable')
        }
      }),
      f.sources
    )
    await expect(broken.run({ action: 'read', noteId: note.id })).rejects.toThrow(
      'storage unavailable'
    )
    await expect(
      broken.run({ action: 'export', noteId: note.id, expectedRevision: note.revision })
    ).rejects.toThrow('storage unavailable')
  })

  it('rejects foreign selections, invented excerpt IDs and quote writes', async () => {
    const f = await fixture()
    await expect(
      f.service.run({
        action: 'create',
        title: 'No',
        itemIds: ['other'],
        excerpts: [
          {
            itemId: 'paper',
            versionId: 'version',
            annotationId: 'annotation',
            expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    ).rejects.toThrow('selection')
    const note = await f.create()
    await expect(
      f.service.run({
        action: 'update',
        noteId: note.id,
        expectedRevision: 1,
        title: note.title,
        blocks: [{ type: 'excerpt', id: 'forged' }]
      })
    ).rejects.toThrow('identity')
    await expect(
      f.service.run({
        action: 'update',
        noteId: note.id,
        expectedRevision: 1,
        title: note.title,
        blocks: [{ type: 'excerpt', id: note.blocks[0].id, text: 'Forged quote' } as never]
      })
    ).rejects.toThrow()
  })

  it('does not publish a failed atomic replacement and remains restartable', async () => {
    const f = await fixture()
    const note = await f.create()
    const before = await readFile(f.path, 'utf8')
    const broken = new LiteratureSynthesisService(
      new LiteratureSynthesisStore(() => f.path, {
        rename: async () => {
          throw new Error('disk failure')
        }
      }),
      f.sources
    )
    await expect(
      broken.run({
        action: 'update',
        noteId: note.id,
        expectedRevision: 1,
        title: 'Unsaved',
        blocks: []
      })
    ).rejects.toThrow('disk failure')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(
      (await readdir(join(f.root, 'literature'))).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
    const read = await f.service.run({ action: 'read', noteId: note.id })
    expect(read.action === 'read' && read.note.title).toBe('Synthesis')
  })

  it('rejects a stale annotation revision before creating a snapshot', async () => {
    const f = await fixture()
    await expect(
      f.service.run({
        action: 'create',
        title: 'Stale',
        itemIds: ['paper'],
        excerpts: [
          {
            itemId: 'paper',
            versionId: 'version',
            annotationId: 'annotation',
            expectedUpdatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })
    ).rejects.toThrow('unavailable')
  })

  it('rejects an oversized note before replacing its durable file', async () => {
    const f = await fixture()
    const note = await f.create()
    const before = await readFile(f.path, 'utf8')
    await expect(
      f.service.run({
        action: 'update',
        noteId: note.id,
        expectedRevision: 1,
        title: 'Too large',
        blocks: Array.from({ length: 110 }, (_, index) => ({
          type: 'text' as const,
          id: `text-${index}`,
          text: 'x'.repeat(20000)
        }))
      })
    ).rejects.toThrow('size limit')
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('honors the data-root migration write gate', async () => {
    const f = await fixture()
    beginMigration()
    await expect(f.create()).rejects.toThrow()
    endMigration()
    expect(await f.create()).toMatchObject({ revision: 1 })
  })

  it('preserves underline and indented prose as paragraphs when parsed as Markdown', async () => {
    const note = await (await fixture()).create()
    note.blocks = [
      { type: 'text', id: 'analysis', text: '第一组\r\n====\n\n    第二组\n\n\t第三组' }
    ]
    const html = await marked.parse(exportSynthesisMarkdown(note))
    expect(html).toContain('<p>第一组\n====</p>')
    expect(html).toContain('<p>&nbsp;&nbsp;&nbsp;&nbsp;第二组</p>')
    expect(html).toContain('<p>&#9;第三组</p>')
  })

  it.each([
    ['CON', '_CON.md'],
    ['pRn', '_pRn.md'],
    ['aux', '_aux.md'],
    ['NUL', '_NUL.md'],
    ['COM1', '_COM1.md'],
    ['lpt9', '_lpt9.md'],
    ['COM¹', '_COM¹.md'],
    ['LPT³', '_LPT³.md'],
    ['CON-study', 'CON-study.md'],
    ['COM10', 'COM10.md'],
    ['con.notes', 'con-notes.md']
  ])('exports the title %s with the portable filename %s', async (title, filename) => {
    const f = await fixture()
    const note = await f.create(title)
    await expect(
      f.service.run({ action: 'export', noteId: note.id, expectedRevision: note.revision })
    ).resolves.toMatchObject({ action: 'export', filename })
  })

  it('saves the suggested Markdown filename at a complete Unicode character boundary', async () => {
    const f = await fixture()
    const title = '综'.repeat(83) + '𠮷'.repeat(10)
    const created = await f.service.run({
      action: 'create',
      title,
      itemIds: ['paper'],
      excerpts: [{ itemId: 'paper', versionId: 'version', annotationId: 'annotation' }]
    })
    if (created.action !== 'create') throw new Error('Unexpected result')
    const result = await f.service.run({
      action: 'export',
      noteId: created.note.id,
      expectedRevision: created.note.revision
    })
    if (result.action !== 'export') throw new Error('Unexpected result')
    expect(result.filename).toBe('综'.repeat(83) + '.md')
    expect(result.markdown.startsWith('# ' + title + '\n')).toBe(true)
    await writeFile(join(f.root, result.filename), result.markdown)
  })

  it('exports author text separately from original text and escapes HTML and Markdown', async () => {
    const f = await fixture()
    const note = await f.create()
    note.blocks.unshift({ type: 'text', id: 'text', text: '# My [claim](javascript:alert(1))' })
    const markdown = exportSynthesisMarkdown(note)
    expect(markdown).toContain('\\# My \\[claim\\]\\(javascript:alert\\(1\\)\\)')
    expect(markdown).toContain('> Original \\*quote\\*\n> &lt;script&gt;x&lt;/script&gt;')
    expect(markdown).toContain('**Annotation note:**\n\n> My annotation')
    expect(markdown).toContain('; p. 3')
    expect(markdown).toContain('DOI: 10\\.1/example')
    expect(markdown).not.toContain('private/path.pdf')
    expect(markdown).not.toContain('<img')
    const html = await marked.parse(markdown)
    expect(html).toContain('<h1>Synthesis</h1>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('Original *quote*\n&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('# My [claim](javascript:alert(1))')
    expect(html).not.toContain('<em>quote</em>')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<script>')
  })
})
