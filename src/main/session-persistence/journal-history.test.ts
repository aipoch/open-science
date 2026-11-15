import { mkdtemp, writeFile, readFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionJournalStore, sessionJournalPath, sessionLegacyBackupPath } from './journal'
const roots: string[] = []
const doc = (revision: number, text: string): { revision: number; text: string } => ({
  revision,
  text
})
const fixture = async (): Promise<{ path: string; store: SessionJournalStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'simple-history-'))
  roots.push(root)
  const path = join(root, 's.json')
  const store = new SessionJournalStore({ maxBytes: 1024 * 1024 })
  // Model already-migrated files without making ordinary legacy saves migrate them.
  await writeFile(
    sessionJournalPath(path),
    JSON.stringify({
      type: 'session_snapshot',
      document: doc(2, 'initial-reference')
    }) + '\n'
  )
  await writeFile(sessionLegacyBackupPath(path), JSON.stringify(doc(1, 'legacy-reference')))
  await store.write(path, { document: doc(3, 'transient-reference'), expectedRevision: 2 })
  await store.write(path, { document: doc(4, 'current'), expectedRevision: 3 })
  return { path, store }
}
const inspect = (
  store: SessionJournalStore,
  path: string,
  visit: (value: unknown) => void = () => {}
): ReturnType<SessionJournalStore['visitRetainedHistory']> =>
  store.visitRetainedHistory(path, { maxBytes: 1024 * 1024, maxRecords: 100, visit })
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('read-only JSONL history inspection', () => {
  it('visits the backup, initial snapshot, transient states and current state without writes', async () => {
    const { path, store } = await fixture()
    const before = await readFile(sessionJournalPath(path), 'utf8')
    const seen: unknown[] = []
    const result = await inspect(store, path, (value) => seen.push(value))
    expect(result.paths).toEqual([sessionJournalPath(path), sessionLegacyBackupPath(path)])
    for (const text of ['legacy-reference', 'initial-reference', 'transient-reference', 'current'])
      expect(JSON.stringify(seen)).toContain(text)
    expect(await readFile(sessionJournalPath(path), 'utf8')).toBe(before)
    await result.assertUnchanged()
    await store.write(path, { document: doc(5, 'later'), expectedRevision: 4 })
    await expect(result.assertUnchanged()).rejects.toThrow('changed during inspection')
  })
  it.each(['physical', 'logical', 'records'] as const)(
    'keeps cumulative %s budgets',
    async (budget) => {
      const { path, store } = await fixture()
      await expect(
        store.visitRetainedHistory(path, {
          maxBytes: budget === 'physical' ? 1 : 1024 * 1024,
          maxLogicalBytes: budget === 'logical' ? 1 : 1024 * 1024,
          maxRecords: budget === 'records' ? 1 : 100,
          visit: () => {}
        })
      ).rejects.toThrow('budget')
    }
  )
  it.each(['half-line', 'bad-line', 'backup', 'missing-primary', 'temporary'] as const)(
    'refuses uncertain %s history and preserves evidence',
    async (fault) => {
      const { path, store } = await fixture()
      if (fault === 'half-line') await appendFile(sessionJournalPath(path), '{partial')
      if (fault === 'bad-line') await appendFile(sessionJournalPath(path), '{broken}\n')
      if (fault === 'backup') await writeFile(sessionLegacyBackupPath(path), '{unknown}')
      if (fault === 'missing-primary') await rm(sessionJournalPath(path))
      if (fault === 'temporary')
        await writeFile(`${sessionJournalPath(path)}.pending.tmp`, '{pending}')
      const paths = (await store.inspectStorage(path)).paths
      const evidence = await Promise.all(paths.map((file) => readFile(file, 'utf8')))
      await expect(inspect(store, path)).rejects.toThrow()
      expect(await Promise.all(paths.map((file) => readFile(file, 'utf8')))).toEqual(evidence)
    }
  )
})
