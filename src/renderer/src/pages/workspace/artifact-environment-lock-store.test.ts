// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateArtifactEnvironmentFromLockResult,
  DescribeArtifactEnvironmentLockRequest
} from '../../../../shared/artifact-reproducibility'
import {
  createEnvironmentFromLock,
  describeEnvironmentLock,
  environmentLockKey,
  retainEnvironmentLocks,
  useArtifactEnvironmentLockStore
} from './artifact-environment-lock-store'

const request: DescribeArtifactEnvironmentLockRequest = {
  projectId: 'project',
  appSessionId: 'session',
  artifactId: 'artifact',
  versionId: 'version',
  lockChecksum: 'a'.repeat(64)
}
const info = {
  schemaVersion: 1,
  format: 'open-science-environment-lock-export',
  lockChecksum: request.lockChecksum,
  lockState: 'available',
  kernelKind: 'python',
  environmentName: 'default-python',
  packageManagers: ['conda']
}
let describeLock: ReturnType<typeof vi.fn>
let createLock: ReturnType<typeof vi.fn>

beforeEach(() => {
  useArtifactEnvironmentLockStore.setState({ entries: new Map() })
  describeLock = vi.fn().mockResolvedValue(info)
  createLock = vi
    .fn()
    .mockResolvedValue({ environmentName: 'repro-a', kernelKind: 'python', reused: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: { describeEnvironmentLock: describeLock, createEnvironmentFromLock: createLock }
    }
  })
})

describe('Artifact Environment lock UI state', () => {
  it('keeps visible locks available above the cache limit and releases them when hidden', async () => {
    const requests = Array.from({ length: 80 }, (_, index) => ({
      ...request,
      versionId: String(index)
    }))
    const release = retainEnvironmentLocks(requests)
    try {
      for (const scope of requests) await describeEnvironmentLock(scope)
      expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(80)
      for (const scope of requests) await describeEnvironmentLock(scope)
      expect(describeLock).toHaveBeenCalledTimes(80)
    } finally {
      release()
    }
    expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(64)
  })
  it('isolates equal checksums by project, session, artifact and version', async () => {
    const scopes = [
      request,
      { ...request, projectId: 'other' },
      { ...request, appSessionId: 'other' },
      { ...request, artifactId: 'other' },
      { ...request, versionId: 'other' }
    ]
    await Promise.all(scopes.map((scope) => describeEnvironmentLock(scope)))
    await Promise.all(scopes.map((scope) => describeEnvironmentLock(scope)))
    expect(describeLock).toHaveBeenCalledTimes(5)
    expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(5)
  })

  it('deduplicates creation and retains its result without subscribers', async () => {
    let resolve!: (value: CreateArtifactEnvironmentFromLockResult) => void
    createLock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = createEnvironmentFromLock(request)
    await createEnvironmentFromLock(request)
    expect(createLock).toHaveBeenCalledTimes(1)
    resolve({ environmentName: 'repro-a', kernelKind: 'python', reused: false })
    await pending
    expect(
      useArtifactEnvironmentLockStore.getState().entries.get(environmentLockKey(request))?.creation
    ).toEqual({
      status: 'ready',
      value: { environmentName: 'repro-a', kernelKind: 'python', reused: false }
    })
  })

  it('retains creation failures for reopening and permits an explicit retry', async () => {
    createLock.mockRejectedValueOnce(new Error('temporary failure'))
    await createEnvironmentFromLock(request)
    expect(
      useArtifactEnvironmentLockStore.getState().entries.get(environmentLockKey(request))?.creation
        ?.status
    ).toBe('error')
    await createEnvironmentFromLock(request)
    expect(createLock).toHaveBeenCalledTimes(2)
    expect(
      useArtifactEnvironmentLockStore.getState().entries.get(environmentLockKey(request))?.creation
        ?.status
    ).toBe('ready')
  })

  it('bounds completed entries without losing in-flight creation', async () => {
    let resolve!: (value: CreateArtifactEnvironmentFromLockResult) => void
    createLock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = createEnvironmentFromLock(request)
    for (let index = 0; index < 80; index++)
      await describeEnvironmentLock({ ...request, versionId: String(index) })
    expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(65)
    expect(
      useArtifactEnvironmentLockStore.getState().entries.get(environmentLockKey(request))?.creation
        ?.status
    ).toBe('pending')
    resolve({ environmentName: 'repro-a', kernelKind: 'python', reused: false })
    await pending
    expect(
      useArtifactEnvironmentLockStore.getState().entries.get(environmentLockKey(request))?.creation
        ?.status
    ).toBe('ready')
    expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(64)
  })

  it('does not repopulate discarded state from late responses', async () => {
    let resolve!: (value: unknown) => void
    describeLock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const pending = describeEnvironmentLock(request)
    useArtifactEnvironmentLockStore.setState({ entries: new Map() })
    resolve(info)
    await pending
    expect(useArtifactEnvironmentLockStore.getState().entries.size).toBe(0)
  })
})
