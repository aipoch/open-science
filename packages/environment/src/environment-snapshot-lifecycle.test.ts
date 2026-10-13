import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { EnvironmentSnapshotInUseError } from './environment-snapshot'
import {
  cleanEnvironmentSnapshotOperation,
  createEnvironmentSnapshotLease,
  reconcileEnvironmentSnapshotOperations
} from './environment-snapshot-lifecycle'
import {
  operationJournalPath,
  readBootToken,
  RuntimeOperationJournal,
  type RuntimeOperationRecord
} from './operation-journal'

vi.mock('./operation-journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operation-journal')>()
  return { ...actual, readBootToken: vi.fn(actual.readBootToken) }
})
const roots: string[] = []
const fixture = async (): Promise<{
  root: string
  runtime: string
  scratch: string
  journal: RuntimeOperationJournal
}> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'snapshot-lifecycle-')))
  roots.push(root)
  const runtime = join(root, 'runtime'),
    scratch = join(root, '.e')
  await mkdir(runtime)
  return {
    root,
    runtime,
    scratch,
    journal: RuntimeOperationJournal.forPath(operationJournalPath(runtime))
  }
}
afterEach(async () => {
  vi.useRealTimers()
  vi.mocked(readBootToken).mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('snapshot restore ownership', () => {
  it('journals scratch identity before use and clears the record after confirmed cleanup', async () => {
    const { runtime, scratch, journal } = await fixture()
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 's-')
    await writeFile(join(lease.root, 'keep'), 'captured')
    expect(await journal.pending()).toEqual([
      expect.objectContaining({
        kind: 'snapshot-restore',
        targetPath: lease.root,
        phase: 'preparing',
        snapshotIdentity: expect.objectContaining({ ino: expect.any(Number) })
      })
    ])
    await expect(
      cleanEnvironmentSnapshotOperation(runtime, (await journal.pending())[0]!)
    ).rejects.toThrow('in use')
    await lease.release()
    expect(await journal.pending()).toEqual([])
    await expect(lstat(lease.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains unknown whole-tree ownership even when the recorded leader PID is absent', async () => {
    const { runtime, scratch, journal } = await fixture()
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 's-')
    lease.beforeSpawn()
    lease.childStarted(2_147_483_600)
    await lease.release(new EnvironmentSnapshotInUseError(undefined))
    await reconcileEnvironmentSnapshotOperations(runtime)
    const independent = await createEnvironmentSnapshotLease(runtime, scratch, 's-')
    await independent.release()
    expect(await journal.pending()).toHaveLength(1)
    expect((await lstat(lease.root)).isDirectory()).toBe(true)
    await lease.release()
  })

  it('automatically retries the same owned process tree and removes its retained clone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime, scratch, journal } = await fixture()
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 's-')
    const retry = vi.fn(async () => true)
    await lease.release(new EnvironmentSnapshotInUseError(undefined, retry))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(async () => expect(await journal.pending()).toEqual([]))
    expect(retry).toHaveBeenCalledTimes(1)
    await expect(lstat(lease.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes retry and migration cleanup and makes repeated cleanup inert', async () => {
    const { runtime, scratch, journal } = await fixture()
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 'r-')
    const retry = vi.fn(async () => true)
    await lease.release(new EnvironmentSnapshotInUseError(undefined, retry))
    const record = (await journal.pending())[0]!
    await Promise.all([
      cleanEnvironmentSnapshotOperation(runtime, record),
      cleanEnvironmentSnapshotOperation(runtime, record)
    ])
    await cleanEnvironmentSnapshotOperation(runtime, record)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(await journal.pending()).toEqual([])
  })

  it('uses an authoritative later boot to reconcile a retained clone on startup', async () => {
    const { runtime, scratch, journal } = await fixture()
    vi.mocked(readBootToken).mockReturnValue('11111111-1111-1111-1111-111111111111')
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 'r-')
    await lease.activate()
    await lease.release(new EnvironmentSnapshotInUseError(undefined))
    vi.mocked(readBootToken).mockReturnValue('22222222-2222-2222-2222-222222222222')
    await reconcileEnvironmentSnapshotOperations(runtime)
    expect(await journal.pending()).toEqual([])
    await expect(lstat(lease.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['preparing', 'reaped'])(
    'recovers a crashed %s clone with no child sidecar',
    async (phase) => {
      const { runtime, scratch, journal } = await fixture()
      const targetPath = join(scratch, 's-abcdef')
      await mkdir(targetPath, { recursive: true })
      const identity = await lstat(targetPath)
      const record: RuntimeOperationRecord = {
        operationId: 'crashed-snapshot',
        kind: 'snapshot-restore',
        runtimeId: 'snapshot:s-abcdef',
        phase,
        startedAt: 1,
        targetPath,
        snapshotIdentity: {
          dev: identity.dev,
          ino: identity.ino,
          birthtimeMs: identity.birthtimeMs
        }
      }
      await journal.begin(record)
      const recovery = new NotebookRecoveryCoordinator(runtime, undefined, {
        verifyExecutable: async () => undefined
      })
      await recovery.recover()
      expect(await journal.pending()).toEqual([])
      await expect(lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('refuses a replaced scratch directory without deleting its new contents', async () => {
    const { root, runtime, scratch, journal } = await fixture()
    const lease = await createEnvironmentSnapshotLease(runtime, scratch, 's-')
    await rename(lease.root, join(root, 'original'))
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'keep'), 'unowned')
    await symlink(other, lease.root, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(lease.release()).rejects.toThrow('identity')
    expect(await readFile(join(other, 'keep'), 'utf8')).toBe('unowned')
    expect(await journal.pending()).toHaveLength(1)
  })
})
