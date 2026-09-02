import { join } from 'node:path'

import { describe, expect, it, type Mock, vi } from 'vitest'

import { createManagedSessionWorkspaceCapability } from './managed-session-workspace'

type ManagedSessionWorkspaceHarness = {
  capability: ReturnType<typeof createManagedSessionWorkspaceCapability>
  createDirectory: Mock<(path: string) => Promise<void>>
  removeDirectory: Mock<(path: string) => Promise<void>>
  initializeOwnership: Mock<(path: string, projectId: string, dataRoot: string) => Promise<void>>
  finalizeOwnership: Mock<(path: string, sessionId: string, dataRoot: string) => Promise<void>>
  removeOwnership: Mock<(path: string, dataRoot: string) => Promise<void>>
}

const createCapability = (): ManagedSessionWorkspaceHarness => {
  const createDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const removeDirectory = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const initializeOwnership = vi.fn().mockResolvedValue(undefined)
  const finalizeOwnership = vi.fn().mockResolvedValue(undefined)
  const removeOwnership = vi.fn().mockResolvedValue(undefined)
  const capability = createManagedSessionWorkspaceCapability({
    resolveRoot: () => '/relocatable/data',
    createId: () => 'workspace-id',
    createDirectory,
    removeDirectory,
    initializeOwnership,
    finalizeOwnership,
    removeOwnership
  })
  return {
    capability,
    createDirectory,
    removeDirectory,
    initializeOwnership,
    finalizeOwnership,
    removeOwnership
  }
}

describe('managed Session workspace capability', () => {
  it('allocates a unique provisional workspace under the current data root', async () => {
    const { capability, createDirectory, initializeOwnership } = createCapability()

    const lease = await capability.acquire({ projectId: 'project-1' })

    expect(lease.cwd).toBe(join('/relocatable/data', 'workspaces', 'workspace-id'))
    expect(createDirectory).toHaveBeenCalledOnce()
    expect(createDirectory).toHaveBeenCalledWith(lease.cwd)
    expect(initializeOwnership).toHaveBeenCalledWith(lease.cwd, 'project-1', '/relocatable/data')
  })

  it('resolves the data root when each workspace is acquired', async () => {
    let dataRoot = '/data-before-relocation'
    const createDirectory = vi.fn().mockResolvedValue(undefined)
    const capability = createManagedSessionWorkspaceCapability({
      resolveRoot: () => dataRoot,
      createId: () => 'workspace-id',
      createDirectory,
      initializeOwnership: vi.fn().mockResolvedValue(undefined)
    })
    dataRoot = '/data-after-relocation'

    const lease = await capability.acquire({ projectId: 'project-1' })

    expect(lease.cwd).toBe(join(dataRoot, 'workspaces', 'workspace-id'))
    expect(createDirectory).toHaveBeenCalledWith(lease.cwd)
  })

  it('releases an uncommitted workspace at most once', async () => {
    const { capability, removeDirectory, removeOwnership } = createCapability()
    const lease = await capability.acquire({ projectId: 'project-1' })

    await lease.release()
    await lease.release()

    expect(removeDirectory).toHaveBeenCalledOnce()
    expect(removeDirectory).toHaveBeenCalledWith(lease.cwd)
    expect(removeOwnership).toHaveBeenCalledWith(lease.cwd, '/relocatable/data')
  })

  it('retains a committed workspace when the lease is released', async () => {
    const { capability, finalizeOwnership, removeDirectory } = createCapability()
    const lease = await capability.acquire({ projectId: 'project-1' })

    await lease.commit('session-1')
    await lease.release()

    expect(finalizeOwnership).toHaveBeenCalledWith(lease.cwd, 'session-1', '/relocatable/data')
    expect(removeDirectory).not.toHaveBeenCalled()
  })

  it('keeps rollback best effort when directory removal fails', async () => {
    const { capability, removeDirectory, removeOwnership } = createCapability()
    const lease = await capability.acquire({ projectId: 'project-1' })
    removeDirectory.mockRejectedValueOnce(new Error('remove failed'))

    await expect(lease.release()).resolves.toBeUndefined()
    expect(removeOwnership).not.toHaveBeenCalled()
  })

  it('releases the provisional workspace when final publication fails', async () => {
    const { capability, finalizeOwnership, removeDirectory, removeOwnership } = createCapability()
    const lease = await capability.acquire({ projectId: 'project-1' })
    finalizeOwnership.mockRejectedValueOnce(new Error('receipt publication failed'))

    await expect(lease.commit('session-1')).rejects.toThrow('receipt publication failed')
    await lease.release()

    expect(removeDirectory).toHaveBeenCalledWith(lease.cwd)
    expect(removeOwnership).toHaveBeenCalledWith(lease.cwd, '/relocatable/data')
  })
})
