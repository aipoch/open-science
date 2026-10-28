// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importSessionPackage } from './session-package-import'
import { sessionPackageImportAvailable } from './session-package-capabilities'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import type { PackageOperationSnapshot } from '../../../shared/session-package'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

beforeEach(() => {
  usePackageOperationStore.setState({
    operation: null,
    open: false,
    dismissedId: undefined,
    importError: undefined
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
})

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

it('deduplicates drops before the first main-process progress event', async () => {
  let finish!: () => void
  const pending = new Promise<null>((resolve) => {
    finish = () => resolve(null)
  })
  const importPackage = vi.fn(() => pending)
  vi.stubGlobal('api', { sessions: { importPackage } })
  const file = new File(['fixture'], 'research.science')
  const first = importSessionPackage('existing-project', file)
  await importSessionPackage('existing-project', file)
  expect(importPackage).toHaveBeenCalledExactlyOnceWith({ projectId: 'existing-project' }, file)
  finish()
  await first
  await importSessionPackage('existing-project', file)
  expect(importPackage).toHaveBeenCalledTimes(2)
})

it('passes a dropped package without a destination to the existing project-selection flow', async () => {
  const importPackage = vi.fn(async () => null)
  vi.stubGlobal('api', { sessions: { importPackage } })
  const file = new File(['fixture'], 'research.science')
  await importSessionPackage(undefined, file)
  expect(importPackage).toHaveBeenCalledExactlyOnceWith({}, file)
})

// Web has no stageLocalFile, so every package travels through bounded chunk uploads first.
const stageableUploads = (
  path = '/uploads/research.science'
): Record<string, ReturnType<typeof vi.fn>> => {
  const beginTransfer = vi.fn(async () => ({
    transferId: 'transfer',
    name: 'research.science',
    receivedBytes: 0,
    totalBytes: 7
  }))
  const appendTransfer = vi.fn(async (request: { offset: number; chunk: Uint8Array }) => ({
    transferId: 'transfer',
    name: 'research.science',
    receivedBytes: request.offset + request.chunk.byteLength,
    totalBytes: 7
  }))
  return {
    beginTransfer,
    appendTransfer,
    getTransferStatus: vi.fn(async () => null),
    finishTransfer: vi.fn(async () => ({ path })),
    abortTransfer: vi.fn(async () => {}),
    deleteUpload: vi.fn(async () => {})
  }
}

const enableWeb = (location: 'local' | 'remote'): void => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, location)
}

const stubWebApi = (
  importPackage: ReturnType<typeof vi.fn>,
  uploads = stageableUploads()
): ReturnType<typeof stageableUploads> => {
  vi.stubGlobal('api', {
    sessions: { importPackage, packageOperation: vi.fn(async () => null) },
    uploads,
    projects: { list: vi.fn(async () => []) }
  })
  return uploads
}

describe('Web session package import', () => {
  it('offers import on local Web only', () => {
    vi.stubGlobal('api', { sessions: { importPackage: vi.fn() } })
    expect(sessionPackageImportAvailable()).toBe(true)
    enableWeb('local')
    expect(sessionPackageImportAvailable()).toBe(true)
    enableWeb('remote')
    expect(sessionPackageImportAvailable()).toBe(false)
  })

  it('stages the package in chunks and imports the staged path', async () => {
    enableWeb('local')
    const importPackage = vi.fn(async () => ({ imported: { projectId: 'p', sessionId: 's' } }))
    const uploads = stubWebApi(importPackage)
    await importSessionPackage('existing-project', new File(['fixture'], 'research.science'))
    expect(uploads.beginTransfer).toHaveBeenCalledOnce()
    expect(uploads.appendTransfer).toHaveBeenCalledOnce()
    expect(importPackage).toHaveBeenCalledExactlyOnceWith(
      { projectId: 'existing-project' },
      '/uploads/research.science'
    )
    // The main owner releases the staged source, including after retries.
    expect(uploads.deleteUpload).not.toHaveBeenCalled()
    expect(usePackageOperationStore.getState().importError).toBeUndefined()
  })

  it('keeps the staged package when the import itself fails', async () => {
    enableWeb('local')
    const importPackage = vi.fn(async () => {
      throw new Error('Not enough disk space')
    })
    const uploads = stubWebApi(importPackage)
    await importSessionPackage('existing-project', new File(['fixture'], 'research.science'))
    expect(uploads.deleteUpload).not.toHaveBeenCalled()
    expect(usePackageOperationStore.getState().importError).toBe('Not enough disk space')
  })

  it('refuses a non-.science upload before staging anything', async () => {
    enableWeb('local')
    const importPackage = vi.fn(async () => null)
    const uploads = stubWebApi(importPackage)
    await importSessionPackage('existing-project', new File(['fixture'], 'notes.txt'))
    expect(uploads.beginTransfer).not.toHaveBeenCalled()
    expect(importPackage).not.toHaveBeenCalled()
    expect(usePackageOperationStore.getState().importError).toContain('.science')
  })

  it('keeps the file picker alive when focus precedes a valid selection', async () => {
    enableWeb('local')
    const importPackage = vi.fn(async () => null)
    stubWebApi(importPackage, stageableUploads('/uploads/picked.science'))
    const pending = importSessionPackage('existing-project')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.accept).toBe('.science,.SCIENCE')
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(document.body.contains(input)).toBe(true)
    Object.defineProperty(input!, 'files', {
      value: [new File(['fixture'], 'picked.science')],
      configurable: true
    })
    input!.dispatchEvent(new Event('change'))
    await pending
    expect(importPackage).toHaveBeenCalledExactlyOnceWith(
      { projectId: 'existing-project' },
      '/uploads/picked.science'
    )
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('returns silently on a dismissed picker and stays importable', async () => {
    enableWeb('local')
    const importPackage = vi.fn(async () => null)
    stubWebApi(importPackage)
    const pending = importSessionPackage('existing-project')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    input!.dispatchEvent(new Event('cancel'))
    await pending
    expect(importPackage).not.toHaveBeenCalled()
    expect(usePackageOperationStore.getState().importError).toBeUndefined()
    // The importing flag was released by the dismissal, so the next request still stages.
    await importSessionPackage('existing-project', new File(['fixture'], 'retry.science'))
    expect(importPackage).toHaveBeenCalledOnce()
  })

  it('never reaches staging from a remote Web caller', async () => {
    enableWeb('remote')
    const importPackage = vi.fn(async () => null)
    const uploads = stubWebApi(importPackage)
    await importSessionPackage('existing-project', new File(['fixture'], 'research.science'))
    expect(uploads.beginTransfer).not.toHaveBeenCalled()
    expect(importPackage).not.toHaveBeenCalled()
  })
})
