import type { ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
const mocks = vi.hoisted(() => ({
  readOwner: vi.fn(),
  birth: vi.fn(),
  alive: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  receipts: vi.fn()
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: mocks.readOwner
}))
vi.mock('../src/main/process-birth-identity', () => ({ processBirthIdentity: mocks.birth }))
vi.mock('../src/main/runtime-stop-confirmation', () => ({ isRuntimeProcessAlive: mocks.alive }))
vi.mock('../src/main/runtime-ownership', () => ({ acquireRuntimeDirectorySync: mocks.acquire }))
vi.mock('../src/main/delegation/process-ownership', () => ({
  DelegatedProcessOwnership: class {
    receipts = mocks.receipts
  }
}))

import {
  captureFixtureProcess,
  captureFixtureAgents,
  captureFixtureService,
  captureFixtureRoot,
  cleanupFixtureProcess,
  cleanupFixtureService,
  cleanupFixtureAgent,
  remainingFixtureAgentReceipts,
  runFixtureCleanup,
  makeCapturedFixtureDirectoriesWritable,
  type CapturedFixtureRoot
} from '../e2e/fixtures/local-service-cleanup'

const generation = 'd1ed69cd-9883-452a-9ddd-e67c4a530a1e'
const owner = {
  schemaVersion: 1,
  generation,
  pid: 12345,
  birthToken: 'birth-1',
  desktop: { generation }
}
const target = { configRoot: '/private-fixture', pid: owner.pid, generation, birthToken: 'birth-1' }

describe('captured fixture root permission repair', () => {
  const containers: string[] = []
  const privateRoot = async (): Promise<{ container: string; root: string }> => {
    const container = await mkdtemp(join(tmpdir(), 'fixture-root-permission-guard-'))
    containers.push(container)
    const root = join(container, 'root')
    await mkdir(root)
    return { container, root }
  }
  afterEach(async () => {
    for (const container of containers.splice(0)) {
      await makeCapturedFixtureDirectoriesWritable(await captureFixtureRoot(container))
      await rm(container, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'repairs a captured 0555 skill directory without changing its 0444 ordinary file',
    async () => {
      const { root } = await privateRoot()
      const captured = await captureFixtureRoot(root)
      const skill = join(root, 'skill')
      const stamp = join(skill, '.catalog_stamp')
      await mkdir(skill)
      await writeFile(stamp, 'private fixture stamp')
      await chmod(stamp, 0o444)
      await chmod(skill, 0o555)
      await makeCapturedFixtureDirectoriesWritable(captured)
      expect((await lstat(skill)).mode & 0o777).toBe(0o755)
      expect((await lstat(stamp)).mode & 0o777).toBe(0o444)
      await rm(root, { recursive: true })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not traverse or chmod a symbolic link to an external private directory',
    async () => {
      const { container, root } = await privateRoot()
      const external = join(container, 'external')
      await mkdir(external)
      await chmod(external, 0o555)
      const link = join(root, 'linked-skill')
      await symlink(external, link, 'dir')
      await makeCapturedFixtureDirectoriesWritable(await captureFixtureRoot(root))
      expect((await lstat(external)).mode & 0o777).toBe(0o555)
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
    }
  )

  it('rejects a replacement root before changing or removing it', async () => {
    const { container, root } = await privateRoot()
    const captured = await captureFixtureRoot(root)
    await rename(root, join(container, 'original'))
    await mkdir(root, { mode: 0o555 })
    const before = await lstat(root)
    await expect(makeCapturedFixtureDirectoriesWritable(captured)).rejects.toThrow(
      'root identity changed'
    )
    expect((await lstat(root)).mode).toBe(before.mode)
  })

  it('rejects unknown root tokens and refuses to capture a root symlink', async () => {
    const { container, root } = await privateRoot()
    const captured = await captureFixtureRoot(root)
    await expect(makeCapturedFixtureDirectoriesWritable(undefined)).rejects.toThrow(
      'was not captured'
    )
    await expect(
      makeCapturedFixtureDirectoriesWritable({ ...captured } as CapturedFixtureRoot)
    ).rejects.toThrow('was not captured')
    const link = join(container, 'root-link')
    await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(captureFixtureRoot(link)).rejects.toThrow('not a symbolic link')
    expect((await lstat(root)).ino).toBe(captured.ino)
  })
})

describe('isolated fixture process cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.readOwner.mockResolvedValue(JSON.stringify(owner))
    mocks.birth.mockReturnValue('birth-1')
    mocks.alive.mockReturnValue(true)
    mocks.acquire.mockReturnValue({ release: mocks.release })
    mocks.receipts.mockReturnValue([])
    vi.spyOn(process, 'kill').mockImplementation(() => {
      mocks.alive.mockReturnValue(false)
      return true
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('captures an exact service identity and can clean it after the owner record is removed', async () => {
    const captured = await captureFixtureService(target.configRoot)
    expect(captured).toEqual(target)
    mocks.readOwner.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    await cleanupFixtureService(captured)
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
    expect(mocks.acquire).toHaveBeenCalledExactlyOnceWith(target.configRoot)
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('supports a directly spawned child without weakening production legacy ownership rules', async () => {
    const child = { pid: owner.pid, exitCode: null, signalCode: null } as ChildProcess
    await cleanupFixtureProcess(captureFixtureProcess(child))
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
  })

  it('waits through an unreadable birth identity until actual death without another signal', async () => {
    vi.useFakeTimers()
    vi.mocked(process.kill).mockImplementation(() => {
      mocks.birth.mockReturnValue(undefined)
      return true
    })
    const cleanup = cleanupFixtureService(target)
    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.acquire).not.toHaveBeenCalled()
    mocks.alive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(50)
    await cleanup
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('uses a captured direct child exit even while PID observation is stale or unreadable', async () => {
    vi.useFakeTimers()
    const child = { pid: owner.pid, exitCode: null, signalCode: null } as ChildProcess
    const captured = captureFixtureProcess(child)
    vi.mocked(process.kill).mockImplementation(() => {
      mocks.birth.mockReturnValue(undefined)
      return true
    })
    const cleanup = cleanupFixtureProcess(captured)
    child.signalCode = 'SIGTERM'
    await vi.advanceTimersByTimeAsync(50)
    await cleanup
    await cleanupFixtureProcess(captured)
    expect(mocks.alive()).toBe(true)
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
  })

  it('keeps a persistently unreadable live PID unconfirmed and refuses forced signaling', async () => {
    vi.useFakeTimers()
    vi.mocked(process.kill).mockImplementation(() => {
      mocks.birth.mockReturnValue(undefined)
      return true
    })
    const rejected = expect(cleanupFixtureService(target)).rejects.toThrow('is unreadable')
    await vi.advanceTimersByTimeAsync(22_000)
    await rejected
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it('requires durable ownership and matching birth identity for separately grouped agents', () => {
    mocks.receipts.mockReturnValue([
      { receiptId: 'receipt-1', ownership: { leader: { pid: 54321, birthToken: 'birth-1' } } }
    ])
    expect(captureFixtureAgents(target)[0]).toEqual({
      pid: 54321,
      birthToken: 'birth-1',
      receiptId: 'receipt-1'
    })
    mocks.birth.mockImplementation((pid) => (pid === owner.pid ? 'birth-1' : 'reused-agent-pid'))
    expect(() => captureFixtureAgents(target)).toThrow('agent identity changed')
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('captures durable agents after their service has already died, under the root lock', async () => {
    mocks.alive.mockImplementation((pid) => pid !== owner.pid)
    mocks.receipts.mockReturnValue([
      {
        receiptId: 'receipt-1',
        phase: 'cleanup-pending',
        ownership: { leader: { pid: 54321, birthToken: 'birth-1' } }
      }
    ])
    const agents = captureFixtureAgents(target)
    expect(agents[0]).toMatchObject({ pid: 54321, birthToken: 'birth-1', receiptId: 'receipt-1' })
    expect(mocks.acquire).toHaveBeenCalledWith(target.configRoot)
    expect(mocks.release).toHaveBeenCalledOnce()
    await cleanupFixtureAgent(agents[0])
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(54321, 'SIGTERM')
    // A reaped leader alone cannot clear the persistent evidence of its tree/Job.
    expect(remainingFixtureAgentReceipts(target.configRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receiptId: 'receipt-1', phase: 'cleanup-pending' })
      ])
    )
  })

  it('retains unknown tree/Job receipts instead of claiming complete cleanup from no leader PID', () => {
    mocks.alive.mockReturnValue(false)
    mocks.receipts.mockReturnValue([
      { receiptId: 'unknown-job', phase: 'cleanup-pending', ownership: { platform: 'win32' } }
    ])
    expect(captureFixtureAgents(target)).toEqual([])
    expect(remainingFixtureAgentReceipts(target.configRoot)).not.toEqual([])
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('rejects an invalid owner before inspecting or signaling its PID', async () => {
    mocks.readOwner.mockResolvedValue(JSON.stringify({ ...owner, pid: -1 }))
    await expect(captureFixtureService(target.configRoot)).rejects.toThrow('owner is invalid')
    expect(mocks.alive).not.toHaveBeenCalled()
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('refuses a service whose birth identity differs from the persisted identity', async () => {
    mocks.birth.mockReturnValue('another-process')
    await expect(captureFixtureService(target.configRoot)).rejects.toThrow('cannot be captured')
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('never signals a reused PID or reports its directory as released', async () => {
    mocks.birth.mockReturnValue('another-process')
    await expect(cleanupFixtureService(target)).rejects.toThrow('identity changed')
    expect(process.kill).not.toHaveBeenCalled()
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it('rechecks identity immediately before signaling', async () => {
    mocks.birth.mockReturnValueOnce('birth-1').mockReturnValue('another-process')
    await expect(cleanupFixtureService(target)).rejects.toThrow('identity changed')
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('does not kill a replacement process after the graceful wait', async () => {
    vi.useFakeTimers()
    vi.mocked(process.kill).mockImplementation(() => true)
    const cleanup = cleanupFixtureService(target)
    const rejected = expect(cleanup).rejects.toThrow('identity changed')
    await vi.advanceTimersByTimeAsync(21_950)
    mocks.birth.mockReturnValue('another-process')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
  })

  it('bounds both graceful and forced cleanup without declaring an unreaped process stopped', async () => {
    vi.useFakeTimers()
    vi.mocked(process.kill).mockImplementation(() => true)
    const rejected = expect(cleanupFixtureService(target)).rejects.toThrow('did not exit')
    await vi.advanceTimersByTimeAsync(23_500)
    await rejected
    expect(vi.mocked(process.kill).mock.calls).toEqual([
      [owner.pid, 'SIGTERM'],
      [owner.pid, 'SIGKILL']
    ])
    expect(mocks.acquire).not.toHaveBeenCalled()
  })

  it('retains a lock failure instead of deleting lock or owner evidence', async () => {
    mocks.alive.mockReturnValue(false)
    mocks.acquire.mockImplementation(() => {
      throw new Error('directory still locked')
    })
    await expect(cleanupFixtureService(target)).rejects.toThrow('directory still locked')
    expect(process.kill).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })

  it('runs service cleanup even if desktop close fails and preserves primary and cleanup failures', async () => {
    const bodyFailure = new Error('assertion failed')
    const closeFailure = new Error('desktop close failed')
    const close = vi.fn().mockRejectedValue(closeFailure)
    const last = vi.fn().mockResolvedValue(undefined)
    await expect(
      runFixtureCleanup([close, () => cleanupFixtureService(target), last], bodyFailure)
    ).rejects.toMatchObject({ errors: [bodyFailure, closeFailure] })
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM')
    expect(last).toHaveBeenCalledOnce()
  })
})
