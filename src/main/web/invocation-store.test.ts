import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getWebInvocationStore,
  WebInvocationStore,
  type WebInvocationRecord
} from './invocation-store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const record = (): WebInvocationRecord => ({
  projectId: 'project',
  sessionId: 'session',
  branchId: 'branch',
  promptMessageId: 'prompt',
  agentFrameId: 'frame',
  runtimeSegmentId: 'segment',
  invocationId: 'invocation',
  operation: 'fetch',
  input: { url: 'https://example.org/research?unredacted=original' },
  attempt: 1,
  configGeneration: 'generation',
  status: 'started',
  createdAt: 1,
  updatedAt: 1
})
const fixture = async (): Promise<{ root: string; store: WebInvocationStore }> => {
  const root = await mkdtemp(join(tmpdir(), 'web-ledger-'))
  roots.push(root)
  return { root: join(root, 'private'), store: getWebInvocationStore(join(root, 'private')) }
}

describe('private Web invocation durability', () => {
  it('uses a shared owner and retains exact inputs across restart with private files', async () => {
    const f = await fixture()
    expect(getWebInvocationStore(f.root)).toBe(f.store)
    const original = record()
    await f.store.create(original)
    expect(await new WebInvocationStore(f.root).read(original, original.invocationId)).toEqual(
      original
    )
    const directory = join(f.root, (await readdir(f.root))[0])
    const file = join(
      directory,
      (await readdir(directory)).find((name) => name.endsWith('.json'))!
    )
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    await expect(
      f.store.read({ ...original, sessionId: 'other' }, original.invocationId)
    ).rejects.toThrow()
  })
  it('serializes competing updates and rejects identity changes without corrupting the prior record', async () => {
    const f = await fixture()
    const original = record()
    await f.store.create(original)
    await Promise.all(
      Array.from({ length: 5 }, () =>
        f.store.mutate(original, original.invocationId, (value) => ({
          ...value,
          attempt: value.attempt + 1
        }))
      )
    )
    expect((await f.store.read(original, original.invocationId)).attempt).toBe(6)
    await expect(
      f.store.mutate(original, original.invocationId, (value) => ({ ...value, sessionId: 'other' }))
    ).rejects.toThrow(/identity/)
    expect((await f.store.read(original, original.invocationId)).sessionId).toBe(original.sessionId)
  })
  it('permanent deletion fences writes and restart reads, preserving only the durable tombstone', async () => {
    const f = await fixture()
    const original = record()
    await f.store.create(original)
    await f.store.deleteSession(original)
    await expect(f.store.create({ ...original, invocationId: 'late' })).rejects.toThrow(/deleted/)
    await expect(f.store.mutate(original, original.invocationId, (value) => value)).rejects.toThrow(
      /deleted/
    )
    await expect(
      new WebInvocationStore(f.root).read(original, original.invocationId)
    ).rejects.toThrow(/deleted/)
    const directory = join(f.root, (await readdir(f.root))[0])
    expect((await readdir(directory)).sort()).toEqual(['deleted', 'scope'])
  })
  it('enumerates query-only and early cancellation scopes from durable identity indices', async () => {
    const f = await fixture()
    const original = record()
    await f.store.create(original)
    const early = {
      projectId: 'project',
      sessionId: 'early',
      invocationId: 'early-cancel',
      operation: 'search' as const,
      input: { query: 'private query' },
      configGeneration: 'generation',
      createdAt: 1
    }
    await f.store.cancelUndispatched(early)
    const restarted = new WebInvocationStore(f.root)
    expect(await restarted.ownedSessions()).toEqual(
      expect.arrayContaining([
        { projectId: original.projectId, sessionId: original.sessionId },
        { projectId: early.projectId, sessionId: early.sessionId }
      ])
    )
    await restarted.deleteSession(early)
    await expect(restarted.readUndispatchedCancellation(early, early.invocationId)).rejects.toThrow(
      /deleted/
    )
    expect(await restarted.ownedSessions()).toContainEqual({
      projectId: early.projectId,
      sessionId: early.sessionId
    })
  })
})
