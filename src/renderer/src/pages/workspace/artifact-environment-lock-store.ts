import { create } from 'zustand'
import type {
  ArtifactEnvironmentLockBundleInfo,
  CreateArtifactEnvironmentFromLockResult,
  DescribeArtifactEnvironmentLockRequest
} from '../../../../shared/artifact-reproducibility'

type Operation<T> = { status: 'pending' } | { status: 'error' } | { status: 'ready'; value: T }

type LockEntry = {
  details?: Operation<ArtifactEnvironmentLockBundleInfo>
  creation?: Operation<CreateArtifactEnvironmentFromLockResult>
}

// Preview tabs unmount when hidden. Keep requests and their results for this renderer's lifetime;
// this is UI state only. Main still validates evidence when exporting or creating an environment.
export const useArtifactEnvironmentLockStore = create<{
  entries: ReadonlyMap<string, LockEntry>
}>(() => ({ entries: new Map() }))

export const environmentLockKey = (request: DescribeArtifactEnvironmentLockRequest): string =>
  JSON.stringify([
    request.projectId,
    request.appSessionId,
    request.artifactId,
    request.versionId,
    request.lockChecksum
  ])

const visibleKeys = new Map<string, number>()

const trimEntries = (entries: Map<string, LockEntry>): Map<string, LockEntry> => {
  const disposable = [...entries].filter(
    ([key, entry]) =>
      !visibleKeys.has(key) &&
      entry.details?.status !== 'pending' &&
      entry.creation?.status !== 'pending'
  )
  for (const [key] of disposable.slice(0, Math.max(0, disposable.length - 64))) entries.delete(key)
  return entries
}

// Visible rows and in-flight work stay discoverable; retain only 64 other completed entries.
export const retainEnvironmentLocks = (
  requests: DescribeArtifactEnvironmentLockRequest[]
): (() => void) => {
  const keys = requests.map(environmentLockKey)
  for (const key of keys) visibleKeys.set(key, (visibleKeys.get(key) ?? 0) + 1)
  return () => {
    for (const key of keys) {
      const count = visibleKeys.get(key) ?? 0
      if (count <= 1) visibleKeys.delete(key)
      else visibleKeys.set(key, count - 1)
    }
    useArtifactEnvironmentLockStore.setState(({ entries }) => ({
      entries: trimEntries(new Map(entries))
    }))
  }
}

const updateEntry = (key: string, change: Partial<LockEntry>): void => {
  useArtifactEnvironmentLockStore.setState(({ entries: current }) => {
    const entries = new Map(current)
    const value = { ...entries.get(key), ...change }
    entries.delete(key)
    entries.set(key, value)
    return { entries: trimEntries(entries) }
  })
}

export const describeEnvironmentLock = async (
  request: DescribeArtifactEnvironmentLockRequest,
  retry = false
): Promise<void> => {
  const key = environmentLockKey(request)
  const current = useArtifactEnvironmentLockStore.getState().entries.get(key)?.details
  if (current && !(retry && current.status === 'error')) return
  const pending = { status: 'pending' } as const
  updateEntry(key, { details: pending })
  let result: Operation<ArtifactEnvironmentLockBundleInfo>
  try {
    if (!window.api?.artifacts.describeEnvironmentLock)
      throw new Error('Environment lock inspection is unavailable.')
    result = { status: 'ready', value: await window.api.artifacts.describeEnvironmentLock(request) }
  } catch {
    result = { status: 'error' }
  }
  if (useArtifactEnvironmentLockStore.getState().entries.get(key)?.details === pending) {
    updateEntry(key, { details: result })
  }
}

export const createEnvironmentFromLock = async (
  request: DescribeArtifactEnvironmentLockRequest
): Promise<void> => {
  const key = environmentLockKey(request)
  if (useArtifactEnvironmentLockStore.getState().entries.get(key)?.creation?.status === 'pending') {
    return
  }
  const pending = { status: 'pending' } as const
  updateEntry(key, { creation: pending })
  let result: Operation<CreateArtifactEnvironmentFromLockResult>
  try {
    if (!window.api?.artifacts.createEnvironmentFromLock)
      throw new Error('Environment creation is unavailable.')
    result = {
      status: 'ready',
      value: await window.api.artifacts.createEnvironmentFromLock(request)
    }
  } catch {
    result = { status: 'error' }
  }
  if (useArtifactEnvironmentLockStore.getState().entries.get(key)?.creation === pending) {
    updateEntry(key, { creation: result })
  }
}
