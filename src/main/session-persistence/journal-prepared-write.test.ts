import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionJournalStore, SessionJournalRevisionError, sessionJournalPath } from './journal'
const roots: string[] = []
type TestDocument = {
  version: number
  session: {
    id: string
    projectId: string
    revision: number
    messages: { id: string; content: string }[]
  }
}
const doc = (revision: number, content = 'history'): TestDocument => ({
  version: 2,
  session: { id: 's', projectId: 'p', revision, messages: [{ id: 'm', content }] }
})
const store = (): SessionJournalStore => new SessionJournalStore({ maxBytes: 1024 * 1024 })
const fixture = async (
  format: 'legacy' | 'journal' = 'journal'
): Promise<{ root: string; path: string; owner: SessionJournalStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'simple-prepared-'))
  roots.push(root)
  const path = join(root, 's.json')
  const owner = store()
  if (format === 'legacy') await writeFile(path, JSON.stringify(doc(1)))
  else await owner.write(path, { document: doc(1), expectedRevision: 0 })
  return { root, path, owner }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('prepared business updates', () => {
  it('publishes an immutable journal result once and retains its format', async () => {
    const { path, owner } = await fixture()
    const raw = doc(2, 'continued')
    const prepared = owner.prepareWrite(path, raw, (await owner.read(path))!)
    raw.session.messages[0].content = 'changed after admission'
    expect(Object.isFrozen(prepared.document)).toBe(true)
    await owner.writePrepared(path, prepared, { expectedRevision: 1 })
    expect(await store().read(path)).toMatchObject({
      format: 'journal',
      document: doc(2, 'continued')
    })
    const authority = sessionJournalPath(path)
    const evidence = await readFile(authority, 'utf8')
    await expect(
      owner.writePrepared(path, prepared, { expectedRevision: 1 })
    ).rejects.toBeInstanceOf(SessionJournalRevisionError)
    expect(await readFile(authority, 'utf8')).toBe(evidence)
  })
  it('reads an over-budget source once for a prepared save', async () => {
    const { path } = await fixture()
    let replays = 0
    const owner = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      maxCacheBytes: 1,
      dependencies: {
        async *readChunks(file) {
          replays++
          yield await readFile(file)
        }
      }
    })
    const previous = (await owner.read(path))!
    const prepared = owner.prepareWrite(path, doc(2, 'continued'), previous)
    await owner.writePrepared(path, prepared, { expectedRevision: 1 })
    expect(replays).toBe(1)
    expect((await store().read(path))?.document).toEqual(doc(2, 'continued'))
  })
  it('leaves legacy JSON preparation to the repository snapshot writer', async () => {
    const { root, path, owner } = await fixture('legacy')
    const evidence = await readFile(path, 'utf8')
    const previous = (await owner.read(path))!
    expect(() => owner.prepareWrite(path, doc(2), previous)).toThrow('snapshot writer')
    expect(await readFile(path, 'utf8')).toBe(evidence)
    expect(await readdir(root)).toEqual(['s.json'])
    expect(await store().read(path)).toMatchObject({ format: 'legacy', document: doc(1) })
  })
  it('rejects forged, foreign and other-path capabilities', async () => {
    const { path, owner, root } = await fixture()
    const previous = (await owner.read(path))!
    expect(() => owner.prepareWrite(path, doc(2), { ...previous })).toThrow('authority read')
    expect(() => store().prepareWrite(path, doc(2), previous)).toThrow('authority read')
    const prepared = owner.prepareWrite(path, doc(2), previous)
    await expect(
      owner.writePrepared(path, { ...prepared }, { expectedRevision: 1 })
    ).rejects.toThrow('another owner')
    await expect(
      owner.writePrepared(join(root, 'other.json'), prepared, { expectedRevision: 1 })
    ).rejects.toThrow('another owner')
    await expect(store().writePrepared(path, prepared, { expectedRevision: 1 })).rejects.toThrow(
      'another owner'
    )
  })
  it.each(['legacy', 'journal'] as const)(
    'binds %s authority when an external replacement keeps the same revision',
    async (format) => {
      const { path, owner } = await fixture(format)
      const previous = (await owner.read(path))!
      const proof = owner.authorityFingerprint(previous)
      owner.invalidate(path)
      expect(owner.authorityFingerprint((await owner.read(path))!)).toBe(proof)
      expect(() => owner.authorityFingerprint({ ...previous })).toThrow('authority proof')
      expect(() => store().authorityFingerprint(previous)).toThrow('authority proof')
      const prepared = format === 'journal' ? owner.prepareWrite(path, doc(2), previous) : undefined
      await writeFile(
        format === 'legacy' ? path : sessionJournalPath(path),
        JSON.stringify(
          format === 'legacy'
            ? doc(1, 'external replacement')
            : {
                type: 'session_snapshot',
                document: doc(1, 'external replacement')
              }
        ) + '\n'
      )
      expect(owner.authorityFingerprint((await owner.read(path))!)).not.toBe(proof)
      if (prepared)
        await expect(owner.writePrepared(path, prepared, { expectedRevision: 1 })).rejects.toThrow(
          'authority changed'
        )
      else expect(() => owner.prepareWrite(path, doc(2), previous)).toThrow('snapshot writer')
      expect((await store().read(path))?.document).toEqual(doc(1, 'external replacement'))
    }
  )
  it('rejects a prepared journal update when authority becomes legacy JSON', async () => {
    const { root, path, owner } = await fixture()
    const prepared = owner.prepareWrite(path, doc(2), (await owner.read(path))!)
    const external = doc(1, 'external legacy authority')
    const evidence = JSON.stringify(external, null, 2) + '\n'
    await rm(sessionJournalPath(path))
    await writeFile(path, evidence)
    await expect(owner.writePrepared(path, prepared, { expectedRevision: 1 })).rejects.toThrow(
      'snapshot writer'
    )
    expect(await readFile(path, 'utf8')).toBe(evidence)
    expect(await readdir(root)).toEqual(['s.json'])
    for (const reader of [owner, store()])
      expect(await reader.read(path)).toMatchObject({ format: 'legacy', document: external })
  })
})
