import { join } from 'node:path'

import { describe, expect, it, type Mock, vi } from 'vitest'

import { createManagedSessionWorkspaceCapability } from './managed-session-workspace'

type ManagedSessionWorkspaceHarness = {
  capability: ReturnType<typeof createManagedSessionWorkspaceCapability>
  createDirectory: Mock<(path: string) => Promise<void>>
  removeDirectory: Mock<(path: string) => Promise<void>>
}

const createCapability = (): ManagedSessionWorkspaceHarness => {
  const createDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const removeDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const capability = createManagedSessionWorkspaceCapability({
    resolveRoot: () => '/relocatable/data',
    createId: () => 'workspace-id',
    createDirectory,
    removeDirectory
  })
  return { capability, createDirectory, removeDirectory }
}

describe('managed Session workspace capability', () => {
  it('allocates a unique provisional workspace under the current data root', async () => {
    const { capability, createDirectory } = createCapability()

    const lease = await capability.acquire()

    expect(lease.cwd).toBe(join('/relocatable/data', 'workspaces', 'workspace-id'))
    expect(createDirectory).toHaveBeenCalledOnce()
    expect(createDirectory).toHaveBeenCalledWith(lease.cwd)
  })

  it('resolves the data root when each workspace is acquired', async () => {
    let dataRoot = '/data-before-relocation'
    const createDirectory = vi.fn().mockResolvedValue(undefined)
    const capability = createManagedSessionWorkspaceCapability({
      resolveRoot: () => dataRoot,
      createId: () => 'workspace-id',
      createDirectory
    })
    dataRoot = '/data-after-relocation'

    const lease = await capability.acquire()

    expect(lease.cwd).toBe(join(dataRoot, 'workspaces', 'workspace-id'))
    expect(createDirectory).toHaveBeenCalledWith(lease.cwd)
  })

  it('releases an uncommitted workspace at most once', async () => {
    const { capability, removeDirectory } = createCapability()
    const lease = await capability.acquire()

    await lease.release()
    await lease.release()

    expect(removeDirectory).toHaveBeenCalledOnce()
    expect(removeDirectory).toHaveBeenCalledWith(lease.cwd)
  })

  it('retains a committed workspace when the lease is released', async () => {
    const { capability, removeDirectory } = createCapability()
    const lease = await capability.acquire()

    lease.commit()
    await lease.release()

    expect(removeDirectory).not.toHaveBeenCalled()
  })

  it('keeps rollback best effort when directory removal fails', async () => {
    const { capability, removeDirectory } = createCapability()
    const lease = await capability.acquire()
    removeDirectory.mockRejectedValueOnce(new Error('remove failed'))

    await expect(lease.release()).resolves.toBeUndefined()
  })
})
