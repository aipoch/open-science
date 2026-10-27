import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({
  delegated: vi.fn(async () => {}),
  kernels: vi.fn(async () => {}),
  acquired: vi.fn(),
  releaseData: vi.fn(),
  constructed: vi.fn()
}))
vi.mock('./delegation/process-ownership', () => ({
  DelegatedProcessOwnership: class {
    constructor(root: string, namespace = 'delegation-process-ownership') {
      f.constructed(root, namespace)
    }
    recover = f.delegated
  }
}))
vi.mock('./notebook/kernel-process-lifecycle.windows-posix', () => ({
  KernelProcessLifecycleOwner: class {
    constructor(options: { storageRoot: string }) {
      f.constructed(options.storageRoot, 'kernels')
    }
    recover = f.kernels
  }
}))
vi.mock('./runtime-ownership', () => ({ acquireRuntimeDirectorySync: f.acquired }))
import { recoverStoppedServiceProcesses } from './service-process-recovery'
const roots: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  f.delegated.mockResolvedValue(undefined)
  f.kernels.mockResolvedValue(undefined)
  f.acquired.mockImplementation((directory: string) => ({ directory, release: f.releaseData }))
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(): Promise<{
  configRoot: string
  dataRoot: string
  lease: { directory: string; release: () => void }
  deadlineAt: number
}> {
  const root = await mkdtemp(join(tmpdir(), 'stopped-service-recovery-'))
  roots.push(root)
  await mkdir(join(root, 'data'))
  const configRoot = await realpath(root)
  const dataRoot = join(configRoot, 'data')
  const lease = { directory: configRoot, release: vi.fn() }
  return { configRoot, dataRoot, lease, deadlineAt: Date.now() + 5000 }
}

it('recovers only receipts protected by the exact Config Root and Data Root locks', async () => {
  const target = await fixture()
  await recoverStoppedServiceProcesses(target)
  expect(f.acquired).toHaveBeenCalledExactlyOnceWith(target.dataRoot)
  expect(f.constructed.mock.calls).toEqual([
    [target.configRoot, 'main-agent-process-ownership'],
    [target.dataRoot, 'delegation-process-ownership'],
    [target.dataRoot, 'kernels']
  ])
  expect(f.delegated).toHaveBeenCalledTimes(2)
  expect(f.kernels).toHaveBeenCalledOnce()
  expect(f.releaseData).toHaveBeenCalledOnce()
  expect(target.lease.release).not.toHaveBeenCalled()
})

it('refuses a mismatched or expired lease boundary without starting a reaper', async () => {
  const target = await fixture()
  await expect(
    recoverStoppedServiceProcesses({
      ...target,
      lease: { ...target.lease, directory: target.dataRoot }
    })
  ).rejects.toThrow('matching Config Root')
  await expect(
    recoverStoppedServiceProcesses({ ...target, deadlineAt: Date.now() - 1 })
  ).rejects.toThrow('deadline')
  expect(f.acquired).not.toHaveBeenCalled()
  expect(f.constructed).not.toHaveBeenCalled()
})

it('does not reap another owner of the Data Root', async () => {
  const target = await fixture()
  f.acquired.mockImplementationOnce(() => {
    throw new Error('Data Root is still owned')
  })
  await expect(recoverStoppedServiceProcesses(target)).rejects.toThrow('still owned')
  expect(f.constructed).not.toHaveBeenCalled()
})

it('retains unresolved receipt failures while still attempting all known ownership families', async () => {
  const target = await fixture()
  f.delegated.mockRejectedValueOnce(new Error('unknown birth identity'))
  await expect(recoverStoppedServiceProcesses(target)).rejects.toThrow('incomplete')
  expect(f.delegated).toHaveBeenCalledTimes(2)
  expect(f.kernels).toHaveBeenCalledOnce()
  expect(f.releaseData).toHaveBeenCalledOnce()
})

it('keeps the Data Root fenced until late recovery settles after its caller times out', async () => {
  const target = await fixture()
  vi.useFakeTimers()
  const pending = Promise.withResolvers<void>()
  f.delegated.mockReturnValueOnce(pending.promise)
  const recovery = recoverStoppedServiceProcesses({ ...target, deadlineAt: Date.now() + 50 })
  const outcome = expect(recovery).rejects.toThrow('deadline')
  await vi.advanceTimersByTimeAsync(50)
  await outcome
  expect(f.releaseData).not.toHaveBeenCalled()
  pending.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.releaseData).toHaveBeenCalledOnce()
})
