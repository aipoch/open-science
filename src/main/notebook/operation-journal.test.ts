import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeOperationJournal, type RuntimeOperationRecord } from './operation-journal'

const roots: string[] = []
const journalPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'op-journal-'))
  roots.push(dir)
  return join(dir, 'runtime', 'operation-journal.json')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const record = (over: Partial<RuntimeOperationRecord> = {}): RuntimeOperationRecord => ({
  operationId: 'op-1',
  kind: 'materialize',
  runtimeId: 'default-python',
  phase: 'solving',
  startedAt: 100,
  ...over
})

describe('RuntimeOperationJournal', () => {
  it('records intent with begin() and reads it back with pending()', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    expect(await journal.pending()).toEqual([])

    await journal.begin(record({ targetPath: '/rt/packs/.incoming-x' }))
    const pending = await journal.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      operationId: 'op-1',
      kind: 'materialize',
      runtimeId: 'default-python',
      targetPath: '/rt/packs/.incoming-x'
    })
  })

  it('complete() removes an operation and deletes the file once the last one clears', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await journal.begin(record({ operationId: 'a' }))
    await journal.begin(record({ operationId: 'b', runtimeId: 'my-analysis' }))
    expect(existsSync(path)).toBe(true)

    await journal.complete('a')
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['b'])
    expect(existsSync(path)).toBe(true)

    await journal.complete('b')
    expect(await journal.pending()).toEqual([])
    // The file is removed entirely, so "no file" unambiguously means "nothing in flight".
    expect(existsSync(path)).toBe(false)
    // complete() is idempotent.
    await journal.complete('b')
    expect(await journal.pending()).toEqual([])
  })

  it('begin() with an existing operationId replaces it (idempotent re-begin)', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record({ phase: 'solving' }))
    await journal.begin(record({ phase: 'downloading' }))
    const pending = await journal.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].phase).toBe('downloading')
  })

  it('update() patches an in-flight op (phase/childPid) and no-ops for an unknown id', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record())
    await journal.update('op-1', { phase: 'downloading', childPid: 4242, childStartedAt: 111 })
    expect(await journal.pending()).toEqual([
      expect.objectContaining({ operationId: 'op-1', phase: 'downloading', childPid: 4242 })
    ])

    await journal.update('missing', { phase: 'x' })
    expect((await journal.pending())[0].phase).toBe('downloading')
  })

  it('hasRuntimeOperation() guards against a second op on the same runtime', async () => {
    const journal = new RuntimeOperationJournal(await journalPath())
    await journal.begin(record({ operationId: 'a', runtimeId: 'default-python' }))
    expect(await journal.hasRuntimeOperation('default-python')).toBe(true)
    expect(await journal.hasRuntimeOperation('default-r')).toBe(false)
  })

  it('treats a missing or corrupt journal as empty (best-effort recovery)', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    // Missing file.
    expect(await journal.pending()).toEqual([])
    // Corrupt content + non-record entries are dropped, never thrown.
    await journal.begin(record())
    await writeFile(path, '{ not json', 'utf8')
    expect(await journal.pending()).toEqual([])
  })

  it('serializes overlapping begins so concurrent writes never lose an entry', async () => {
    const path = await journalPath()
    const journal = new RuntimeOperationJournal(path)
    await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        journal.begin(record({ operationId: `op-${i}`, runtimeId: `rt-${i}` }))
      )
    )
    const pending = await journal.pending()
    expect(pending).toHaveLength(8)
    // The persisted file is valid JSON (no torn write) with all 8 records.
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(8)
  })
})
