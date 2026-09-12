// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importSessionPackage } from './session-package-import'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import type { PackageOperationSnapshot } from '../../../shared/session-package'

beforeEach(() => {
  usePackageOperationStore.setState({
    operation: null,
    open: false,
    dismissedId: undefined,
    importError: undefined
  })
})
afterEach(() => vi.unstubAllGlobals())

it('opens native import directly for the current project', async () => {
  const importPackage = vi.fn(async () => null)
  vi.stubGlobal('api', { sessions: { importPackage } })
  await importSessionPackage('existing-project')
  expect(importPackage).toHaveBeenCalledExactlyOnceWith({ projectId: 'existing-project' })
})

it('retains a fallback error after the project menu has closed', async () => {
  vi.stubGlobal('api', {
    sessions: {
      importPackage: vi.fn(async () => {
        throw new Error('Project is unavailable')
      })
    }
  })
  await importSessionPackage('existing-project')
  expect(usePackageOperationStore.getState().importError).toBe('Project is unavailable')
})

it.each([false, true])(
  'recovers a late failure without replacing a newer operation (retry: %s)',
  async (retry) => {
    const failure: PackageOperationSnapshot = {
      id: 'fast-import',
      kind: 'import',
      state: 'failed',
      progress: { phase: 'preparing' },
      error: 'Not enough disk space'
    }
    let resolveSnapshot!: (value: PackageOperationSnapshot) => void
    const pendingSnapshot = new Promise<PackageOperationSnapshot>((resolve) => {
      resolveSnapshot = resolve
    })
    const packageOperation = vi.fn(() => pendingSnapshot)
    vi.stubGlobal('api', {
      sessions: {
        importPackage: vi.fn(async () => {
          throw new Error(failure.error)
        }),
        packageOperation
      }
    })
    const importing = importSessionPackage('existing-project')
    await vi.waitFor(() => expect(packageOperation).toHaveBeenCalled())
    const next: PackageOperationSnapshot = {
      id: 'retry-import',
      kind: 'import',
      state: 'running',
      progress: { phase: 'copying' }
    }
    if (retry) {
      usePackageOperationStore.getState().receive(failure)
      usePackageOperationStore.getState().receive(next)
    }
    resolveSnapshot(failure)
    await importing
    expect(usePackageOperationStore.getState()).toMatchObject({
      operation: retry ? next : failure,
      open: true,
      importError: undefined
    })
  }
)
