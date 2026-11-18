import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultFileDurability } from '@aipoch/durable-files'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SessionJournalStore,
  SessionJournalRevisionError,
  SessionJournalSizeError,
  sessionJournalPath,
  sessionLegacyBackupPath,
  type SessionJournalDependencies
} from './journal'

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
  session: {
    id: 's',
    projectId: 'p',
    revision,
    messages: [{ id: 'm', content }]
  }
})
const fixture = async (
  deps: SessionJournalDependencies = {},
  maxBytes = 1024 * 1024
): Promise<{ root: string; path: string; store: SessionJournalStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'simple-session-journal-'))
  roots.push(root)
  return {
    root,
    path: join(root, 's.json'),
    store: new SessionJournalStore({ maxBytes, dependencies: deps })
  }
}
const fresh = (maxBytes = 1024 * 1024): SessionJournalStore => new SessionJournalStore({ maxBytes })
const write = (
  store: SessionJournalStore,
  path: string,
  revision: number,
  content = 'history'
): ReturnType<SessionJournalStore['write']> =>
  store.write(path, { document: doc(revision, content), expectedRevision: revision - 1 })
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('simple Session JSONL persistence', () => {
  it('reads large UTF-8 lines across a reused chunk buffer and keeps an incomplete tail', async () => {
    const { path, store } = await fixture()
    const content = '汉字😀\\n'.repeat(12_000)
    await write(store, path, 1, content)
    await write(store, path, 2, `${content}继续`)
    const target = sessionJournalPath(path)
    await appendFile(target, '{"type":"session_update","revision":3')
    const evidence = await readFile(target)
    // Split inside UTF-8 characters; the producer owns and overwrites this buffer, just like
    // the real file reader. Other cold-read cases cover several complete lines in one chunk.
    const reader = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        readChunks: async function* () {
          const buffer = Buffer.alloc(257)
          for (let offset = 0; offset < evidence.length; offset += buffer.length) {
            const size = evidence.copy(buffer, 0, offset, offset + buffer.length)
            yield buffer.subarray(0, size)
          }
        }
      }
    })
    expect((await reader.read(path))?.document).toEqual(doc(2, `${content}继续`))
    expect((await fresh().read(path))?.document).toEqual(doc(2, `${content}继续`))
    expect(await readFile(target)).toEqual(evidence)
  })

  it('streams split UTF-8 records and rejects authority changed during a read', async () => {
    const { path, store } = await fixture()
    await write(store, path, 1, '汉字😀')
    await write(store, path, 2, '汉字😀继续')
    const split = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        readChunks: async function* (file) {
          const bytes = await readFile(file)
          for (let index = 0; index < bytes.length; index++) yield bytes.subarray(index, index + 1)
        }
      }
    })
    expect((await split.read(path))?.document).toEqual(doc(2, '汉字😀继续'))
    const short = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        readChunks: async function* (file) {
          const bytes = await readFile(file)
          yield bytes.subarray(0, bytes.indexOf(10) + 1)
        }
      }
    })
    await expect(short.read(path)).rejects.toThrow('not read completely')
    const concurrent = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        readChunks: async function* (file) {
          yield await readFile(file)
          await write(fresh(), path, 3, 'external')
        }
      }
    })
    await expect(concurrent.read(path)).rejects.toThrow('changed while reading')
    expect((await fresh().read(path))?.document).toEqual(doc(3, 'external'))
  })

  it('reads legacy JSON unchanged and leaves writes to the repository snapshot writer', async () => {
    const { root, path, store } = await fixture()
    const original = JSON.stringify(doc(1), null, 2) + '\n'
    await writeFile(path, original)
    const stat = await lstat(path)
    expect((await store.read(path))?.format).toBe('legacy')
    expect(await readdir(root)).toEqual(['s.json'])
    expect((await lstat(path)).mtimeMs).toBe(stat.mtimeMs)
    await expect(write(store, path, 2, 'continued')).rejects.toThrow('snapshot writer')
    await expect(write(fresh(), path, 2, 'continued again')).rejects.toThrow('snapshot writer')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await lstat(path)).mtimeMs).toBe(stat.mtimeMs)
    expect(await readdir(root)).toEqual(['s.json'])
    expect(await fresh().read(path)).toMatchObject({
      format: 'legacy',
      document: doc(1),
      revision: 1
    })
  })
  it.each([null, '12', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'retains legacy revision compatibility without accepting invalid JSONL revisions: %s',
    async (revision) => {
      const { path, root, store } = await fixture()
      const document = { ...doc(0), session: { ...doc(0).session, revision } }
      const original = JSON.stringify(document, null, 2) + '\n'
      await writeFile(path, original)
      expect(await store.read(path)).toMatchObject({ format: 'legacy', revision: 0, document })
      expect(await readFile(path, 'utf8')).toBe(original)
      await expect(write(store, path, 1, 'continued')).rejects.toThrow('snapshot writer')
      expect(await readdir(root)).toEqual(['s.json'])
      expect((await fresh().read(path))?.document).toEqual(document)
      expect(await readFile(path, 'utf8')).toBe(original)

      // Retained data from a previous migration must not hide corrupt JSONL authority.
      await writeFile(sessionLegacyBackupPath(path), original)
      const corrupt = JSON.stringify({ type: 'session_snapshot', document }) + '\n'
      await writeFile(sessionJournalPath(path), corrupt)
      await expect(fresh().read(path)).rejects.toThrow('Invalid Session revision')
      await expect(write(fresh(), path, 1)).rejects.toThrow('Invalid Session revision')
      expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(corrupt)
    }
  )
  it('appends one ordinary update per save without manifests, checkpoints, receipts or hashes', async () => {
    const { root, path, store } = await fixture()
    await write(store, path, 1, 'large history '.repeat(1000))
    const initial = await readFile(sessionJournalPath(path), 'utf8')
    for (let revision = 2; revision <= 140; revision++)
      await write(store, path, revision, `next ${revision}`)
    const text = await readFile(sessionJournalPath(path), 'utf8')
    expect(text.startsWith(initial)).toBe(true)
    expect(await readdir(root)).toEqual(['s.jsonl'])
    const lines = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(140)
    for (const line of lines.slice(1))
      expect(Object.keys(line)).toEqual(['type', 'revision', 'records'])
    expect((await fresh().read(path))?.document).toEqual(doc(140, 'next 140'))
    expect((await fresh().read(sessionJournalPath(path)))?.document).toEqual(doc(140, 'next 140'))
  })
  it('retains complete saves, ignores a half line on reads and truncates only that tail on the next write', async () => {
    const { path, store } = await fixture()
    await write(store, path, 1)
    await write(store, path, 2, 'saved')
    const target = sessionJournalPath(path)
    const complete = await readFile(target, 'utf8')
    await appendFile(target, '{"type":"session_update","revision":3')
    const interrupted = await readFile(target, 'utf8')
    expect((await fresh().read(path))?.document).toEqual(doc(2, 'saved'))
    expect(await readFile(target, 'utf8')).toBe(interrupted)
    await write(fresh(), path, 3, 'resumed')
    expect((await fresh().read(path))?.document).toEqual(doc(3, 'resumed'))
    expect((await readFile(target, 'utf8')).startsWith(complete)).toBe(true)
  })
  it.each(['bad-json', 'revision-gap', 'unknown-record', 'document-revision'])(
    'rejects complete corruption: %s',
    async (fault) => {
      const { path, store } = await fixture()
      await write(store, path, 1)
      const target = sessionJournalPath(path)
      const record = {
        type: 'session_update',
        revision: fault === 'revision-gap' ? 3 : 2,
        records:
          fault === 'unknown-record'
            ? [{ type: 'unknown' }]
            : [{ type: 'snapshot', document: doc(fault === 'document-revision' ? 3 : 2) }]
      }
      await appendFile(target, fault === 'bad-json' ? '{broken}\n' : JSON.stringify(record) + '\n')
      const evidence = await readFile(target, 'utf8')
      await expect(fresh().read(path)).rejects.toThrow()
      await expect(write(fresh(), path, 2)).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe(evidence)
    }
  )
  it('keeps the original revision CAS after an append completed but fsync failed', async () => {
    const { path, store } = await fixture()
    await write(store, path, 1)
    let fail = true
    const flaky = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        syncFile: async (file) => {
          if (file.endsWith('.jsonl') && fail) {
            fail = false
            throw new Error('sync failed')
          }
          await defaultFileDurability.syncFile(file)
        }
      }
    })
    await expect(write(flaky, path, 2, 'saved once')).rejects.toThrow('sync failed')
    const evidence = await readFile(sessionJournalPath(path), 'utf8')
    expect((await fresh().read(path))?.revision).toBe(2)
    await expect(write(flaky, path, 2, 'saved once')).rejects.toBeInstanceOf(
      SessionJournalRevisionError
    )
    expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(evidence)
  })
  it('recovers a partial failed append by retrying against the still-current revision', async () => {
    const { path, store } = await fixture()
    await write(store, path, 1)
    const flaky = new SessionJournalStore({
      maxBytes: 1024 * 1024,
      dependencies: {
        appendFile: async (file, text) => {
          await appendFile(file, text.slice(0, 30))
          throw new Error('interrupted')
        }
      }
    })
    await expect(write(flaky, path, 2, 'partial')).rejects.toThrow('interrupted')
    expect((await fresh().read(path))?.revision).toBe(1)
    await write(fresh(), path, 2, 'recovered')
    expect((await fresh().read(path))?.document).toEqual(doc(2, 'recovered'))
  })
  it.each([0, 1])('rejects legacy revision %i before any storage mutation', async (revision) => {
    const mutation = vi.fn(async () => {
      throw new Error('unexpected storage mutation')
    })
    const { root, path, store } = await fixture({
      rename: mutation,
      appendFile: mutation,
      truncate: mutation,
      syncFile: mutation,
      syncDirectory: mutation
    })
    const original = JSON.stringify(doc(revision))
    await writeFile(path, original)
    await expect(write(store, path, revision + 1)).rejects.toThrow('snapshot writer')
    expect(mutation).not.toHaveBeenCalled()
    expect((await fresh().read(path))?.document).toEqual(doc(revision))
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(readFile(sessionLegacyBackupPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sessionJournalPath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual(['s.json'])
  })
  it('observes external JSON replacements and rejects both stale and current journal writes', async () => {
    const { root, path, store } = await fixture()
    await writeFile(path, JSON.stringify(doc(1)))
    const external = doc(3, 'external writer committed')
    const externalBytes = JSON.stringify(external, null, 2) + '\n'
    expect((await store.read(path))?.revision).toBe(1)
    await writeFile(path, externalBytes)
    for (const reader of [store, fresh()]) {
      expect(await reader.read(path)).toMatchObject({
        format: 'legacy',
        revision: 3,
        document: external
      })
      await expect(write(reader, path, 3, 'stale overwrite')).rejects.toMatchObject({
        name: 'SessionJournalRevisionError',
        expectedRevision: 2,
        actualRevision: 3
      })
      await expect(write(reader, path, 4, 'current overwrite')).rejects.toThrow('snapshot writer')
    }
    expect(await readFile(path, 'utf8')).toBe(externalBytes)
    expect(await readdir(root)).toEqual(['s.json'])
  })
  it('rejects a journal append when its authority has become legacy JSON', async () => {
    const { root, path, store } = await fixture()
    await write(store, path, 1)
    const external = doc(1, 'external legacy authority')
    const evidence = JSON.stringify(external, null, 2) + '\n'
    await rm(sessionJournalPath(path))
    await writeFile(path, evidence)
    await expect(write(store, path, 2, 'stale journal update')).rejects.toThrow('snapshot writer')
    expect(await readFile(path, 'utf8')).toBe(evidence)
    expect(await readdir(root)).toEqual(['s.json'])
    for (const reader of [store, fresh()])
      expect(await reader.read(path)).toMatchObject({ format: 'legacy', document: external })
  })
  it('keeps existing JSONL authority when a redundant legacy file and backup coexist', async () => {
    const { path } = await fixture()
    await write(fresh(), path, 1)
    await writeFile(path, JSON.stringify(doc(1)))
    await writeFile(sessionLegacyBackupPath(path), JSON.stringify(doc(1)))
    await write(fresh(), path, 2, 'current')
    expect((await fresh().read(path))?.document).toEqual(doc(2, 'current'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(doc(1))
    expect(JSON.parse(await readFile(sessionLegacyBackupPath(path), 'utf8'))).toEqual(doc(1))
  })
  it('serializes queued appends and releases the lane after a failed CAS', async () => {
    const { path, store } = await fixture()
    await write(store, path, 1)
    await Promise.all([
      write(store, path, 2, 'second'),
      write(store, sessionJournalPath(path), 3, 'third')
    ])
    await expect(write(store, path, 2)).rejects.toBeInstanceOf(SessionJournalRevisionError)
    await write(store, path, 4, 'fourth')
    expect((await fresh().read(path))?.document).toEqual(doc(4, 'fourth'))
  })
  it('bounds logical size and line size while allowing history to exceed the current-document limit', async () => {
    const { path, store } = await fixture({}, 1024)
    await write(store, path, 1)
    for (let revision = 2; revision < 20; revision++)
      await write(store, path, revision, 'x'.repeat(500))
    expect((await lstat(sessionJournalPath(path))).size).toBeGreaterThan(1024)
    expect((await fresh(1024).read(path))?.revision).toBe(19)
    await expect(write(store, path, 20, 'x'.repeat(2000))).rejects.toBeInstanceOf(
      SessionJournalSizeError
    )
    await appendFile(sessionJournalPath(path), 'x'.repeat(130 * 1024))
    await expect(fresh(1024).read(path)).rejects.toBeInstanceOf(SessionJournalSizeError)
  })
  it('refuses missing authority with a backup or unpublished temporary file', async () => {
    const { path } = await fixture()
    await writeFile(sessionLegacyBackupPath(path), JSON.stringify(doc(1)))
    await expect(fresh().read(path)).rejects.toThrow('primary is missing')
    await expect(write(fresh(), path, 1)).rejects.toThrow('primary is missing')
    await rm(sessionLegacyBackupPath(path))
    await writeFile(`${sessionJournalPath(path)}.pending.tmp`, '{partial')
    await expect(write(fresh(), path, 1)).rejects.toThrow('primary is missing')
  })
  it('rejects symlink files and directories before reading or writing', async () => {
    const { path, root } = await fixture()
    const other = join(root, 'other.json')
    await writeFile(other, JSON.stringify(doc(1)))
    await symlink(other, sessionJournalPath(path))
    await expect(fresh().read(path)).rejects.toThrow('regular file')
    await expect(write(fresh(), path, 1)).rejects.toThrow('regular file')
    await rm(sessionJournalPath(path))
    const linked = join(root, 'linked')
    await symlink(root, linked)
    await expect(fresh().read(join(linked, 's.json'))).rejects.toThrow('regular directory')
  })
})
