import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJournalAgentStore } from '@aipoch/agent-harness'
import { HarnessStorageCleanup } from './storage-cleanup'
import { HarnessToolReceipts } from './tool-receipts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})
const fixture = async (): Promise<{
  root: string
  options: { sessionDirectory: string; receiptDirectory(): string; isLive(): boolean }
  store: ReturnType<typeof createJournalAgentStore>
  receipts: HarnessToolReceipts
  query: { invocationId: string; name: string; arguments: Record<string, never> }
  add(providerId: string, sessionId: string, legacy?: boolean): Promise<void>
  setLive(value: boolean): void
}> => {
  const root = await mkdtemp(join(tmpdir(), 'harness-cleanup-'))
  roots.push(root)
  const sessionDirectory = join(root, 'sessions'),
    receiptsDirectory = join(root, 'receipts')
  await mkdir(sessionDirectory)
  let live = false
  const options = {
    sessionDirectory,
    receiptDirectory: () => receiptsDirectory,
    isLive: () => live
  }
  const store = createJournalAgentStore({ directory: join(sessionDirectory, 'checkpoints') })
  const receipts = new HarnessToolReceipts(receiptsDirectory)
  const query = { invocationId: 'call', name: 'execute', arguments: {} }
  const add = async (providerId: string, sessionId: string, legacy = false): Promise<void> => {
    await writeFile(
      join(sessionDirectory, `${providerId}.json`),
      JSON.stringify({
        cwd: root,
        ...(!legacy ? { owner: { projectId: 'project', sessionId } } : {})
      })
    )
    await store.commit(providerId, null, {
      version: 1,
      sessionId: providerId,
      revision: 0,
      messages: [],
      requests: [],
      pending: [],
      compactions: []
    })
    const scope = JSON.stringify(['project', sessionId, 'notebook'])
    const call = { ...query, invocationId: providerId }
    await receipts.begin(scope, call)
    await receipts.complete(scope, call, { content: [{ type: 'text', text: 'result' }] })
  }
  return {
    root,
    options,
    store,
    receipts,
    query,
    add,
    setLive: (value: boolean) => {
      live = value
    }
  }
}
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  c = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  d = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

it('retains live and archived catalog identities, deletes all owned providers, and fences reuse', async () => {
  const f = await fixture()
  await f.add(a, 'deleted')
  await f.add(d, 'deleted')
  await f.add(b, 'retained')
  await f.add(c, 'legacy', true)
  const owner = new HarnessStorageCleanup(f.options)
  await owner.reconcile(['deleted', 'retained'])
  expect(await f.store.load(a)).toBeDefined()
  await owner.commit(['deleted'])
  expect(await f.store.load(a)).toBeUndefined()
  expect(await f.store.load(d)).toBeUndefined()
  expect(await f.store.load(b)).toBeDefined()
  expect(await f.store.load(c)).toBeDefined()
  expect(await readdir(f.options.sessionDirectory)).not.toContain(`${a}.json`)
  const scope = JSON.stringify(['project', 'deleted', 'notebook'])
  await expect(f.receipts.begin(scope, { ...f.query, invocationId: 'late' })).rejects.toThrow(
    'permanently deleted'
  )
  await expect(f.receipts.read(scope, f.query)).rejects.toThrow('permanently deleted')
})

it('recovers committed deletion after restart, preserves provisional identities on later catalog reads', async () => {
  const f = await fixture()
  await f.add(a, 'gone')
  const owner = new HarnessStorageCleanup(f.options)
  await owner.reconcile([])
  expect(await f.store.load(a)).toBeUndefined()
  await f.add(b, 'new-provisional')
  await owner.reconcile([])
  expect(await f.store.load(b)).toBeDefined()
})

it('retains retry evidence on writer conflict and does not delete while live', async () => {
  const f = await fixture()
  await f.add(a, 'session')
  const owner = new HarnessStorageCleanup(f.options)
  await owner.reconcile(['session'])
  f.setLive(true)
  await expect(owner.commit(['session'])).rejects.toThrow('while its Session is live')
  expect(await f.store.load(a)).toBeDefined()
  expect(
    JSON.parse(await readFile(join(f.options.sessionDirectory, `${a}.json`), 'utf8')).owner
      .sessionId
  ).toBe('session')
  f.setLive(false)
  await owner.reconcile([])
  expect(await f.store.load(a)).toBeUndefined()
})

it('retries interrupted cleanup after restart without stealing a journal lock', async () => {
  const f = await fixture()
  await f.add(a, 'deleted')
  const lock = join(
    f.options.sessionDirectory,
    'checkpoints',
    createHash('sha256').update(a).digest('hex') + '.journal.lock'
  )
  await writeFile(lock, 'owned by stopped fixture')
  const owner = new HarnessStorageCleanup(f.options)
  await expect(owner.commit(['deleted'])).rejects.toThrow('lock timeout')
  expect(await readFile(join(f.options.sessionDirectory, `${a}.json`), 'utf8')).toContain('deleted')
  expect(await readFile(lock, 'utf8')).toBe('owned by stopped fixture')
  // The fixture owns this lock and has no writer; production recovery must verify the owner first.
  await rm(lock)
  await new HarnessStorageCleanup(f.options).reconcile([])
  expect(await f.store.load(a)).toBeUndefined()
  expect(await readdir(f.options.sessionDirectory)).not.toContain(`${a}.json`)
})
