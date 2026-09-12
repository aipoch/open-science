import { useNavigationStore } from '@/stores/navigation-store'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionPackageOperation, PackageOperationIndicator } from './SessionPackageOperation'
import { sessionExportLocked, usePackageOperationStore } from '@/stores/package-operation-store'
import type { PackageOperationSnapshot } from '../../../shared/session-package'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const snapshot: PackageOperationSnapshot = {
  id: 'operation-1',
  kind: 'export',
  session: { projectId: 'p', sessionId: 's' },
  state: 'awaiting-selection',
  progress: { phase: 'selecting' },
  files: [
    {
      storageKey: 'artifacts/p/s/small',
      filename: 'plot.png',
      sizeBytes: 1024,
      groupId: 'plot',
      source: 'artifact',
      versionNumber: 1,
      dependentFiles: []
    },
    {
      storageKey: 'artifacts/p/s/large',
      filename: 'result.csv',
      sizeBytes: 512 * 1024 ** 2,
      groupId: 'result',
      source: 'artifact',
      versionNumber: 1,
      dependentFiles: ['Notebook run-1']
    },
    {
      storageKey: 'artifacts/p/s/oversized',
      filename: 'raw.bin',
      sizeBytes: 32 * 1024 ** 3 + 1,
      groupId: 'raw',
      source: 'artifact',
      versionNumber: 1,
      dependentFiles: []
    }
  ]
}
const button = (text: string): HTMLButtonElement => {
  const result = [...document.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(result).toBeDefined()
  return result!
}

it('cancels a hidden export setup directly and waits for the owner to release the Session', async () => {
  let finish!: () => void
  const packageOperation = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('api', { sessions: { packageOperation } })
  usePackageOperationStore.setState({ operation: snapshot, open: false })
  await act(async () => root.render(<PackageOperationIndicator />))
  expect(button('Continue setup')).toBeDefined()
  await act(async () => button('Cancel').click())
  expect(packageOperation).toHaveBeenCalledExactlyOnceWith({
    action: 'cancel',
    operationId: snapshot.id
  })
  expect(button('Cancel').disabled).toBe(true)
  expect(
    sessionExportLocked(usePackageOperationStore.getState().operation, { id: 's', projectId: 'p' })
  ).toBe(true)
  await act(async () => {
    usePackageOperationStore.getState().receive({ ...snapshot, state: 'cancelling' })
    finish()
  })
  expect(button('Cancel').disabled).toBe(true)
  expect(document.body.textContent).toContain('Cancelling and cleaning up…')
  await act(async () =>
    usePackageOperationStore.getState().receive({ ...snapshot, state: 'cancelled' })
  )
  expect(
    sessionExportLocked(usePackageOperationStore.getState().operation, { id: 's', projectId: 'p' })
  ).toBe(false)
  expect(
    [...document.querySelectorAll('button')].some((item) => item.textContent === 'Cancel')
  ).toBe(false)
})

it('keeps failed background cancellation visible and retryable without discarding export choices', async () => {
  const packageOperation = vi.fn().mockRejectedValue(new Error('Could not reach the application.'))
  vi.stubGlobal('api', { sessions: { packageOperation } })
  usePackageOperationStore.setState({
    operation: snapshot,
    open: false,
    excludedStorageKeys: ['large']
  })
  await act(async () => root.render(<PackageOperationIndicator />))
  await act(async () => button('Cancel').click())
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not reach the application.'
  )
  expect(button('Cancel').disabled).toBe(false)
  expect(usePackageOperationStore.getState().excludedStorageKeys).toEqual(['large'])
  await act(async () => button('Continue setup').click())
  expect(usePackageOperationStore.getState().open).toBe(true)
})
beforeEach(() => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  usePackageOperationStore.setState({
    operation: null,
    dismissedId: undefined,
    open: false,
    excludedStorageKeys: null,
    selectionPreset: 'full',
    threshold: '256'
  })
})

it('offers full and compact export without exposing customization and preserves required evidence', async () => {
  const operation: PackageOperationSnapshot = {
    ...snapshot,
    files: snapshot
      .files!.slice(0, 2)
      .map((file, index) => ({ ...file, requiredForEvidence: index === 0 }))
  }
  const packageOperation = vi.fn(async () => operation)
  vi.stubGlobal('api', {
    sessions: { packageOperation, onPackageOperation: () => () => undefined }
  })
  usePackageOperationStore.getState().receive(operation)
  await act(async () => root.render(<SessionPackageOperation />))
  const preset = (name: string): HTMLInputElement =>
    document.querySelector(`input[aria-label="${name}"]`)!
  expect(preset('Full export')).not.toBeNull()
  expect(preset('Essential export').checked).toBe(true)
  expect(document.querySelector('input[type=radio]')).toBe(preset('Essential export'))
  expect(document.querySelector('#package-customization')).toBeNull()
  await act(async () => preset('Essential export').click())
  expect(usePackageOperationStore.getState().excludedStorageKeys).toEqual(['artifacts/p/s/large'])
  await act(async () => button('Customize contents').click())
  const required = document.querySelector<HTMLButtonElement>(
    '[role="checkbox"][aria-label="plot.png"]'
  )!
  expect(required.disabled).toBe(true)
  await act(async () => button('Export').click())
  expect(packageOperation).toHaveBeenCalledWith({
    action: 'select',
    operationId: operation.id,
    excludedStorageKeys: ['artifacts/p/s/large']
  })
  await act(async () => preset('Full export').click())
  expect(usePackageOperationStore.getState().excludedStorageKeys).toEqual([])
})

it('does not label an oversized exclusion as full export and blocks oversized required evidence', async () => {
  let operation = snapshot
  vi.stubGlobal('api', {
    sessions: {
      packageOperation: vi.fn(async () => operation),
      onPackageOperation: () => () => undefined
    }
  })
  usePackageOperationStore.getState().receive(operation)
  await act(async () => root.render(<SessionPackageOperation />))
  const full = document.querySelector<HTMLInputElement>('input[aria-label="Full export"]')!
  expect(full.disabled).toBe(true)
  expect(full.checked).toBe(false)
  expect(document.body.textContent).toContain('Full export is unavailable')
  operation = {
    ...snapshot,
    files: snapshot.files!.map((file) => ({ ...file, requiredForEvidence: true }))
  }
  await act(async () => usePackageOperationStore.getState().receive(operation))
  expect(button('Export').disabled).toBe(true)
  expect(document.body.textContent).toContain('This Session cannot be exported.')
  expect(usePackageOperationStore.getState().excludedStorageKeys).toEqual([])
})

it('keeps speed settings collapsed and changes the current operation budget', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'transfer',
    kind: 'import',
    state: 'running',
    progress: { phase: 'validating' },
    ioBytesPerSecond: 2 * 1024 ** 2
  }
  const packageOperation = vi.fn(async () => operation)
  vi.stubGlobal('api', {
    sessions: { packageOperation, onPackageOperation: () => () => undefined }
  })
  usePackageOperationStore.setState({ operation, open: true })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.body.textContent).toContain('Disk activity: 2.0 MiB/s')
  const settings = [...document.querySelectorAll('details')].find((element) =>
    element.textContent?.includes('Transfer details')
  )!
  expect(settings.open).toBe(false)
  const activity = [...settings.querySelectorAll('p')].find((element) =>
    element.textContent?.includes('Disk activity:')
  )
  expect(activity).toBeDefined()
  const select = settings.querySelector<HTMLButtonElement>('[role="combobox"]')
  expect(select, 'speed selection uses the shared in-app control').not.toBeNull()
  expect(select!.textContent).toContain('16.0 MiB/s')
  Element.prototype.scrollIntoView ??= () => undefined
  await act(async () => {
    settings.open = true
    select!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === '4.0 MiB/s'
  )!
  expect(option).toBeDefined()
  await act(async () => {
    option.click()
  })
  expect(packageOperation).toHaveBeenCalledWith({
    action: 'set-speed',
    operationId: operation.id,
    bytesPerSecond: 4 * 1024 ** 2
  })
})

it('does not relock the source Session while retrying temporary cleanup', () => {
  const session = { id: 's', projectId: 'p' }
  expect(
    sessionExportLocked({ ...snapshot, state: 'running', progress: { phase: 'copying' } }, session)
  ).toBe(true)
  expect(
    sessionExportLocked({ ...snapshot, state: 'running', progress: { phase: 'cleaning' } }, session)
  ).toBe(false)
})

it.each(['succeeded', 'failed', 'cancelled'] as const)(
  'retries only cleanup for a %s import',
  async (state) => {
    const completed: PackageOperationSnapshot = {
      id: 'cleanup-result',
      kind: 'import',
      state,
      progress: { phase: 'importing' },
      cleanupPending: true,
      result: state === 'succeeded' ? { imported: { projectId: 'p', sessionId: 's' } } : undefined
    }
    const packageOperation = vi.fn(async () => completed)
    const importPackage = vi.fn()
    vi.stubGlobal('api', {
      sessions: { packageOperation, importPackage, onPackageOperation: () => () => undefined }
    })
    usePackageOperationStore.setState({ operation: completed, open: true })
    await act(async () => root.render(<SessionPackageOperation />))
    if (state === 'succeeded') expect(button('Open imported Session')).toBeDefined()
    expect(
      [...document.querySelectorAll('button')].some((item) => item.textContent === 'Try again')
    ).toBe(false)
    await act(async () => button('Retry cleanup').click())
    expect(packageOperation).toHaveBeenCalledWith({
      action: 'retry-cleanup',
      operationId: completed.id
    })
    expect(importPackage).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Some temporary files could not be removed. Retry cleanup without repeating the transfer.'
    )
    expect(document.body.textContent).toContain(
      state === 'succeeded'
        ? 'Completed, cleanup pending'
        : state === 'failed'
          ? 'Package operation failed'
          : 'Package operation cancelled'
    )
  }
)

it.each([{}, { projectId: 'existing-project' }])(
  'keeps the chosen import destination on retry (%j)',
  async (importTarget) => {
    const failed: PackageOperationSnapshot = {
      id: 'failed-import',
      kind: 'import',
      importTarget,
      state: 'failed',
      progress: { phase: 'validating' },
      error: 'Import failed'
    }
    const importPackage = vi.fn(async () => null)
    vi.stubGlobal('api', {
      sessions: {
        importPackage,
        onPackageOperation: () => () => undefined,
        packageOperation: async () => failed
      }
    })
    usePackageOperationStore.setState({ operation: failed, open: true })
    await act(async () => root.render(<SessionPackageOperation />))
    await act(async () => button('Try again').click())
    expect(importPackage).toHaveBeenCalledWith(importTarget)
  }
)

it.each(['confirming', 'choosing-location'] as const)(
  'explains the required action while waiting at %s without a transfer meter',
  async (phase) => {
    const waiting: PackageOperationSnapshot = {
      ...snapshot,
      state: 'running',
      progress: { phase, totalBytes: 100, completedBytes: 50 }
    }
    vi.stubGlobal('api', {
      sessions: {
        onPackageOperation: () => () => undefined,
        packageOperation: vi.fn(async () => waiting)
      }
    })
    await act(async () => root.render(<SessionPackageOperation />))
    expect(document.body.textContent).toContain('Waiting for you')
    expect(document.body.textContent).toContain(
      phase === 'confirming'
        ? 'Review the package summary before importing.'
        : 'Choose where to save the package in the system dialog.'
    )
    expect(document.querySelector('progress')).toBeNull()
  }
)

it('labels measurable progress as the current stage and removes stale counters during cleanup', async () => {
  let publish!: (value: PackageOperationSnapshot) => void
  const running: PackageOperationSnapshot = {
    ...snapshot,
    state: 'running',
    progress: { phase: 'copying', totalBytes: 100, completedBytes: 40 }
  }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: (listener: typeof publish) => {
        publish = listener
        return () => undefined
      },
      packageOperation: vi.fn(async () => running)
    }
  })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.body.textContent).toContain('Current stage')
  expect(document.body.textContent).toContain('40%')
  act(() => publish({ ...running, progress: { phase: 'compressing' } }))
  const indeterminate = document.querySelector('[role="progressbar"]')
  expect(indeterminate?.getAttribute('aria-valuetext')).toBe('Compressing package…')
  expect(indeterminate?.hasAttribute('aria-valuenow')).toBe(false)
  expect(document.body.textContent).not.toContain('40%')
  act(() => publish({ ...running, state: 'cancelling' }))
  expect(document.querySelector('progress, [role="progressbar"]')).toBeNull()
  expect(document.body.textContent).not.toContain('40%')
  expect(document.body.textContent).toContain(
    'Removing temporary files. Keep the app open until cleanup finishes.'
  )
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it('starts with a simple export summary and reveals optional controls on request', async () => {
  const request = vi.fn(async () => snapshot)
  vi.stubGlobal('api', {
    sessions: { onPackageOperation: () => () => undefined, packageOperation: request }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  expect(document.querySelector('input[type="number"]')).toBeNull()
  expect(document.activeElement?.textContent).toBe('Export Session package')
  expect(document.querySelector('[role="checkbox"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Transfer settings')
  expect(document.body.textContent).toContain('Selected: 0 / 3 files')
  expect(document.body.textContent).not.toContain('Some file contents are not included')
  await act(async () => button('Export').click())
  expect(request).toHaveBeenLastCalledWith({
    action: 'select',
    operationId: snapshot.id,
    excludedStorageKeys: snapshot.files!.map((file) => file.storageKey)
  })
  act(() => button('Customize contents').click())
  const filters = [...document.querySelectorAll('details')].find(
    (element) => element.querySelector('summary')?.textContent === 'File filters'
  )
  expect(filters?.open).toBe(false)
  expect(
    [...document.querySelectorAll('details')]
      .filter(
        (element) => element.querySelector('summary')?.textContent === 'Versions and dependencies'
      )
      .every((element) => !element.open)
  ).toBe(true)
  expect(document.querySelector('input[type="number"]')).not.toBeNull()
  expect(document.querySelector('[role="checkbox"]')).not.toBeNull()
})

it('allows selecting a 32 GiB file while disabling files over the limit', async () => {
  const inventory = {
    ...snapshot,
    files: [{ ...snapshot.files![0], sizeBytes: 32 * 1024 ** 3 }, snapshot.files![2]]
  }
  const request = vi.fn(async () => inventory)
  vi.stubGlobal('api', {
    sessions: { onPackageOperation: () => () => undefined, packageOperation: request }
  })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.body.textContent).toContain('Selected: 0 / 2 files')
  act(() => button('Customize contents').click())
  expect(document.body.textContent).toContain('Files larger than 32.0 GiB cannot be included.')
  expect(document.querySelector('[role="checkbox"][disabled]')?.getAttribute('aria-label')).toBe(
    'raw.bin'
  )
  act(() => button('Select all').click())
  await act(async () => button('Export').click())
  expect(request).toHaveBeenLastCalledWith({
    action: 'select',
    operationId: snapshot.id,
    excludedStorageKeys: ['artifacts/p/s/oversized']
  })
})

it('shows a matching renamed version beyond the initial version page without changing group selection', async () => {
  const inventory = {
    ...snapshot,
    files: Array.from({ length: 60 }, (_, i) => ({
      ...snapshot.files![0],
      storageKey: `artifacts/p/s/v${i + 1}`,
      versionNumber: i + 1,
      filename: i === 59 ? 'final.csv' : 'draft.csv'
    }))
  }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => inventory)
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() => button('Select all').click())
  const search = document.querySelector('input:not([type])') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'final')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('final.csv')
  expect(document.body.textContent).toContain('Version 60')
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
  expect(document.body.textContent).toContain('All versions')
  act(() => (document.querySelector('[role="checkbox"]') as HTMLElement).click())
  expect(document.body.textContent).toContain('Selected: 0 / 60 files')
})

it('retains the failed processing stage in the result', async () => {
  usePackageOperationStore.setState({ open: true })
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => ({
        ...snapshot,
        state: 'failed',
        progress: { phase: 'saving' },
        error: 'Disk full'
      }))
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  expect(document.body.textContent).toContain('Last stage: Saving package…')
  const alert = document.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('Disk full')
  expect(alert?.textContent).not.toContain('Package operation failed')
  expect(alert?.textContent).not.toContain('Last stage:')
  expect(document.querySelector('details')?.closest('[role="alert"]')).toBeNull()
})

it('selects file contents with a size filter and keeps selection separate from metadata', async () => {
  const request = vi.fn(async () => snapshot)
  let publish!: (value: PackageOperationSnapshot) => void
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: (listener: typeof publish) => {
        publish = listener
        return () => undefined
      },
      packageOperation: request
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() => button('Select all').click())
  expect(document.body.textContent).not.toContain(
    'Conversation and evidence metadata are always included'
  )
  const versions = [...document.querySelectorAll('details')].find(
    (element) =>
      element.parentElement?.textContent?.includes('result.csv') &&
      element.querySelector('summary')?.textContent === 'Versions and dependencies'
  )!
  await act(async () => {
    versions.open = true
    versions.dispatchEvent(new Event('toggle'))
  })
  expect(document.body.textContent).toContain('Notebook run-1')
  act(() => button('Exclude large files').click())
  expect(document.body.textContent).toContain('Selected: 1 / 3 files')
  act(() => (document.querySelector('[aria-label="Hide progress"]') as HTMLButtonElement).click())
  act(() => button('Continue setup').click())
  expect(document.body.textContent).toContain('Selected: 1 / 3 files')
  await act(async () => button('Export').click())
  expect(request).toHaveBeenLastCalledWith({
    action: 'select',
    operationId: 'operation-1',
    excludedStorageKeys: ['artifacts/p/s/oversized', 'artifacts/p/s/large']
  })
  act(() => publish({ ...snapshot, id: 'operation-2' }))
  expect(document.body.textContent).toContain('Selected: 0 / 3 files')
})

it('restores the operation after remount, shows byte progress in background and cancels through the owner', async () => {
  const running = {
    ...snapshot,
    state: 'running' as const,
    files: undefined,
    progress: { phase: 'copying' as const, completedBytes: 50, totalBytes: 100 }
  }
  const request = vi.fn(async () => running)
  const remove = vi.fn()
  vi.stubGlobal('api', {
    sessions: { onPackageOperation: () => remove, packageOperation: request }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  const progress = document.querySelector('progress')!
  expect(progress.value).toBe(50)
  expect(progress.max).toBe(100)
  act(() => (document.querySelector('[aria-label="Hide progress"]') as HTMLButtonElement).click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('progress')?.value).toBe(50)
  expect(document.querySelector('progress')?.max).toBe(100)
  act(() =>
    [...document.querySelectorAll('button')]
      .find((item) => item.textContent === 'View progress')!
      .click()
  )
  await act(async () => button('Cancel').click())
  expect(request).toHaveBeenLastCalledWith({ action: 'cancel', operationId: 'operation-1' })
  act(() => root.render(null))
  expect(remove).toHaveBeenCalledOnce()
})

it('keeps import progress available when hidden and waits for cancellation cleanup', async () => {
  const running: PackageOperationSnapshot = {
    id: 'import',
    kind: 'import',
    state: 'running',
    progress: {
      phase: 'importing',
      completedBytes: 40,
      totalBytes: 100,
      currentFile: 'results.csv'
    }
  }
  let publish!: (value: PackageOperationSnapshot) => void
  const request = vi.fn(async () => running)
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: (listener: typeof publish) => {
        publish = listener
        return () => undefined
      },
      packageOperation: request
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  expect(document.body.textContent).toContain('Importing research…')
  expect(document.body.textContent).toContain('results.csv')
  expect(document.querySelector('progress')?.value).toBe(40)
  act(() => button('Run in background').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).toContain('Importing research…')
  act(() => button('View progress').click())
  await act(async () => button('Cancel').click())
  expect(request).toHaveBeenLastCalledWith({ action: 'cancel', operationId: 'import' })
  act(() => publish({ ...running, state: 'cancelling' }))
  expect(button('Cancel').disabled).toBe(true)
  expect(document.body.textContent).toContain('Cancelling and cleaning up…')
  act(() => publish({ ...running, state: 'cancelled' }))
  expect(document.body.textContent).toContain('Package operation cancelled')
  act(() => button('Close').click())
  expect(document.querySelector('[aria-label="Package progress"]')).toBeNull()
})

it('dismisses a completed operation instead of leaving an undismissable floating action', async () => {
  const completed: PackageOperationSnapshot = { ...snapshot, state: 'succeeded', files: undefined }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => completed)
    }
  })
  usePackageOperationStore.setState({ open: true })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Close').click())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(
    [...document.querySelectorAll('button')].some((item) =>
      item.textContent?.includes('Export Session package')
    )
  ).toBe(false)
})

it('shows retained bytes and small-file units and searches without changing the selection', async () => {
  const inventory = {
    ...snapshot,
    summary: {
      metadataBytes: 0,
      retainedFiles: [
        {
          storageKey: 'notebooks/p/s/results.bin',
          filename: 'results.bin',
          sizeBytes: 128 * 1024 ** 2
        }
      ]
    }
  }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => inventory)
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() => button('Select all').click())
  expect(document.body.textContent).toContain('128.0 MiB')
  expect(document.body.textContent).toContain('640.0 MiB')
  expect(document.body.textContent).toContain('1.0 KiB')
  const search = document.querySelector('input:not([type])') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'plot')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelector('[aria-label="result.csv"]')).toBeNull()
  expect(document.querySelector('[aria-label="plot.png"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Selected: 2 / 3 files')
})

it('shows a partly selected group and retains its draft across a failed export retry', async () => {
  const inventory = {
    ...snapshot,
    files: [
      snapshot.files![0],
      { ...snapshot.files![0], storageKey: 'artifacts/p/s/v2', versionNumber: 2 }
    ]
  }
  let publish!: (value: PackageOperationSnapshot) => void
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: (listener: typeof publish) => {
        publish = listener
        return () => undefined
      },
      packageOperation: vi.fn(async () => inventory)
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() =>
    usePackageOperationStore.setState({
      excludedStorageKeys: ['artifacts/p/s/v2'],
      selectionPreset: 'custom',
      threshold: '12'
    })
  )
  expect(document.querySelector('[aria-label="plot.png"]')?.getAttribute('aria-checked')).toBe(
    'mixed'
  )
  act(() => publish({ ...inventory, state: 'failed', files: undefined }))
  act(() => publish({ ...inventory, id: 'retry', state: 'running', files: undefined }))
  act(() => publish({ ...inventory, id: 'retry' }))
  act(() => button('Customize contents').click())
  expect(document.querySelector('[aria-label="plot.png"]')?.getAttribute('aria-checked')).toBe(
    'mixed'
  )
  expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('12')
})

it('paginates large inventories while selection applies across all pages', async () => {
  const inventory = {
    ...snapshot,
    files: Array.from({ length: 1000 }, (_, i) => ({
      ...snapshot.files![0],
      storageKey: `artifacts/p/s/f${i}`,
      filename: `file${i}`,
      groupId: `f${i}`,
      sizeBytes: i + 1
    }))
  }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => inventory)
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() => button('Select all').click())
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(25)
  expect(document.querySelector('[aria-label="file999"]')).not.toBeNull()
  act(() => button('Next').click())
  expect(document.querySelector('[aria-label="file999"]')).toBeNull()
  expect(document.body.textContent).toContain('Page 2 of 40')
  expect(document.body.textContent).toContain('Selected: 1000 / 1000 files')
})

it('does not carry a previous operation action error into a new transfer', async () => {
  let publish!: (value: PackageOperationSnapshot) => void
  const request = vi.fn(async (action) => {
    if (action.action === 'select') throw new Error('Selection submission failed')
    return snapshot
  })
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: (listener: typeof publish) => {
        publish = listener
        return () => undefined
      },
      packageOperation: request
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  await act(async () => button('Export').click())
  expect(document.body.textContent).toContain('Selection submission failed')
  act(() => publish({ ...snapshot, id: 'next-transfer' }))
  expect(document.body.textContent).not.toContain('Selection submission failed')
})

it('lets the user inspect retained files beyond the first page', async () => {
  const inventory = {
    ...snapshot,
    files: [],
    summary: {
      metadataBytes: 0,
      retainedFiles: [
        ...Array.from({ length: 30 }, (_, i) => ({
          storageKey: `notebooks/p/s/f${i}`,
          filename: `retained-${i}.csv`,
          sizeBytes: i + 1
        })),
        {
          storageKey: 'artifacts/p/s/evidence.json',
          filename: 'artifacts/p/s/evidence.json',
          sizeBytes: 1
        }
      ]
    }
  }
  vi.stubGlobal('api', {
    sessions: {
      onPackageOperation: () => () => undefined,
      packageOperation: vi.fn(async () => inventory)
    }
  })
  await act(async () =>
    root.render(
      <>
        <PackageOperationIndicator />
        <SessionPackageOperation />
      </>
    )
  )
  act(() => button('Customize contents').click())
  act(() => button('View files').click())
  expect(document.querySelector('[title="retained-29.csv"]')).not.toBeNull()
  expect(document.querySelector('[title="retained-0.csv"]')).toBeNull()
  act(() => button('Next').click())
  expect(document.querySelector('[title="retained-0.csv"]')).not.toBeNull()
  expect(document.querySelector('[title="retained-29.csv"]')).toBeNull()
  act(() => button('Artifacts1').click())
  expect(document.querySelector('[title="artifacts/p/s/evidence.json"]')?.textContent).toBe(
    'evidence.json'
  )
  expect(document.querySelector('[title="retained-0.csv"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Page 2')
  act(() => button('Notebook30').click())
  expect(document.body.textContent).toContain('Page 1 of 2')
  expect(document.querySelector('[title="retained-29.csv"]')).not.toBeNull()
})

it('requires an explicit destination for an opened file and hides archived projects', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'opened-file',
    kind: 'import',
    state: 'awaiting-selection',
    progress: { phase: 'selecting' },
    importFilename: 'research.science',
    importRequestId: 'file-request'
  }
  const packageOperation = vi.fn(async () => operation)
  vi.stubGlobal('api', {
    sessions: { packageOperation, onPackageOperation: () => () => undefined },
    projects: {
      list: async () => [
        { id: 'target', name: 'Cancer research', createdAt: 1, updatedAt: 1 },
        { id: 'archived', name: 'Archived research', createdAt: 1, updatedAt: 1, archivedAt: 2 }
      ]
    }
  })
  usePackageOperationStore.setState({ operation, open: true })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(button('Continue').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Archived research')
  expect(document.body.textContent).not.toContain('Choose package contents')
  await act(async () => (document.querySelector('input[value=target]') as HTMLInputElement).click())
  await act(async () => button('Continue').click())
  expect(packageOperation).toHaveBeenCalledWith({
    action: 'select-project',
    operationId: 'opened-file',
    target: { projectId: 'target' }
  })
})

it('keeps import confirmation in one dialog with omissions collapsed', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'review-import',
    kind: 'import',
    state: 'awaiting-selection',
    progress: { phase: 'confirming' },
    importTarget: { projectId: 'target' },
    importFilename: 'research.science',
    importPreview: {
      title: 'Source research',
      projectName: 'Source',
      branchCount: 2,
      messageCount: 12,
      fileCount: 3,
      totalBytes: 1024,
      omissions: [{ kind: 'external', description: 'An external Session was not included.' }]
    }
  }
  const packageOperation = vi.fn(async () => operation)
  vi.stubGlobal('api', {
    sessions: { packageOperation, onPackageOperation: () => () => undefined },
    projects: {
      list: async () => [{ id: 'target', name: 'My research', createdAt: 1, updatedAt: 1 }]
    }
  })
  usePackageOperationStore.setState({ operation, open: true })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(document.body.textContent).toContain('My research')
  expect(document.querySelector('details')?.open).toBe(false)
  expect(document.body.textContent).not.toContain('system dialog')
  await act(async () => button('Import').click())
  expect(packageOperation).toHaveBeenCalledWith({
    action: 'confirm-import',
    operationId: 'review-import'
  })
})

it('does not claim desktop import events on a Web client', async () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  const subscribe = vi.fn(() => () => undefined)
  const query = vi.fn(async () => null)
  vi.stubGlobal('api', { sessions: { packageOperation: query, onPackageOperation: subscribe } })
  try {
    await act(async () => root.render(<SessionPackageOperation />))
    expect(subscribe).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
  }
})

it('does not navigate when restoring a completed import snapshot', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'old-import',
    kind: 'import',
    state: 'succeeded',
    progress: { phase: 'importing' },
    result: { imported: { projectId: 'target', sessionId: 'imported' } }
  }
  const navigate = vi.spyOn(useNavigationStore.getState(), 'openSession')
  vi.stubGlobal('api', {
    sessions: { packageOperation: async () => operation, onPackageOperation: () => () => undefined }
  })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(navigate).not.toHaveBeenCalled()
})

it('navigates once after this desktop window confirms an import', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'confirmed-import',
    kind: 'import',
    state: 'awaiting-selection',
    progress: { phase: 'confirming' },
    importTarget: { projectId: 'target' },
    importPreview: {
      title: 'Source',
      projectName: 'Source',
      branchCount: 1,
      messageCount: 1,
      fileCount: 0,
      totalBytes: 1,
      omissions: []
    }
  }
  const navigate = vi.spyOn(useNavigationStore.getState(), 'openSession').mockReturnValue(true)
  vi.stubGlobal('api', {
    sessions: {
      packageOperation: async () => operation,
      onPackageOperation: () => () => undefined
    },
    projects: {
      list: async () => [{ id: 'target', name: 'My research', createdAt: 1, updatedAt: 1 }]
    }
  })
  usePackageOperationStore.setState({ operation, open: true })
  await act(async () => root.render(<SessionPackageOperation />))
  await act(async () => button('Import').click())
  const completed: PackageOperationSnapshot = {
    ...operation,
    state: 'succeeded',
    importPreview: undefined,
    result: { imported: { projectId: 'target', sessionId: 'imported' } }
  }
  await act(async () => usePackageOperationStore.getState().receive(completed))
  await act(async () => usePackageOperationStore.getState().receive(completed))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('target', 'imported', 'user')
})

it('restores a hidden transfer only for an explicit presentation request', () => {
  const operation: PackageOperationSnapshot = {
    id: 'background',
    kind: 'import',
    state: 'running',
    progress: { phase: 'copying' }
  }
  const store = usePackageOperationStore.getState()
  store.receive(operation)
  store.setOpen(false)
  store.receive({ ...operation, progress: { phase: 'validating' } })
  expect(usePackageOperationStore.getState().open).toBe(false)
  store.receive({ ...operation, presentationRevision: 1 })
  expect(usePackageOperationStore.getState().open).toBe(true)
})

it.each([
  { state: 'running' as const, cleanupPending: false, canOpenNext: false },
  { state: 'succeeded' as const, cleanupPending: true, canOpenNext: false },
  { state: 'succeeded' as const, cleanupPending: false, canOpenNext: true }
])(
  'keeps the waiting queue secondary and respects cleanup: $state/$cleanupPending',
  async ({ state, cleanupPending, canOpenNext }) => {
    const operation: PackageOperationSnapshot = {
      id: 'queued',
      kind: 'import',
      state,
      cleanupPending,
      progress: { phase: 'importing' },
      pendingImports: [{ id: 'next', filename: 'next.science' }]
    }
    const packageOperation = vi.fn(async () => operation)
    vi.stubGlobal('api', { sessions: { packageOperation } })
    usePackageOperationStore.setState({ operation, open: true })
    await act(async () => root.render(<SessionPackageOperation />))
    expect(document.body.textContent).not.toContain('next.science')
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Waiting packages (1)"]'
    )!
    await act(async () => trigger.click())
    expect(document.body.textContent).toContain('next.science')
    expect(document.body.textContent?.includes('Open next package')).toBe(canOpenNext)
    await act(async () => button('Remove').click())
    expect(packageOperation).toHaveBeenCalledWith({
      action: 'discard-import',
      operationId: 'queued',
      requestId: 'next'
    })
    if (canOpenNext) {
      await act(async () => button('Open next package').click())
      expect(packageOperation).toHaveBeenCalledWith({
        action: 'next-import',
        operationId: 'queued'
      })
    }
  }
)

it('shows queue overflow immediately and allows dismissing its warning', async () => {
  const operation: PackageOperationSnapshot = {
    id: 'full',
    kind: 'import',
    state: 'running',
    progress: { phase: 'importing' },
    importQueueFull: true
  }
  const packageOperation = vi.fn(async () => operation)
  vi.stubGlobal('api', { sessions: { packageOperation } })
  usePackageOperationStore.setState({ operation, open: true })
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Waiting list is full.')
  await act(async () => button('Dismiss').click())
  expect(packageOperation).toHaveBeenCalledWith({
    action: 'dismiss-queue-warning',
    operationId: 'full'
  })
})

it('explains the always-included content without displaying an empty optional selection', async () => {
  const operation: PackageOperationSnapshot = {
    ...snapshot,
    files: [],
    summary: { metadataBytes: 8192, retainedFiles: [] }
  }
  vi.stubGlobal('api', {
    sessions: {
      packageOperation: vi.fn(async () => operation),
      onPackageOperation: () => () => undefined
    }
  })
  usePackageOperationStore.getState().receive(operation)
  await act(async () => root.render(<SessionPackageOperation />))
  expect(document.body.textContent).not.toContain('Selected: 0 / 0')
  expect(document.body.textContent).toContain('History and required evidence')
  expect(document.body.textContent).toContain('8.0 KiB')
})

it.each([false, true])(
  'offers a different opened package only after cleanup settles (%s)',
  async (cleanupPending) => {
    const failed: PackageOperationSnapshot = {
      id: 'failed-file',
      kind: 'import',
      state: 'failed',
      progress: { phase: 'validating' },
      importRequestId: 'file-request',
      importTarget: { projectId: 'target-project' },
      error: 'Could not validate package.',
      cleanupPending
    }
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const importPackage = vi.fn(() => pending)
    const packageOperation = vi.fn(async () => failed)
    vi.stubGlobal('api', {
      sessions: { importPackage, packageOperation, onPackageOperation: () => () => undefined }
    })
    usePackageOperationStore.setState({ operation: failed, open: true })
    await act(async () => root.render(<SessionPackageOperation />))
    packageOperation.mockClear()
    if (cleanupPending) {
      expect(
        [...document.querySelectorAll('button')].some(
          (item) => item.textContent === 'Choose another package'
        )
      ).toBe(false)
      expect(button('Retry cleanup')).toBeDefined()
      return
    }
    try {
      act(() => button('Choose another package').click())
      expect(importPackage).toHaveBeenCalledWith({ projectId: 'target-project' })
      expect(button('Choose another package').disabled).toBe(true)
      expect(button('Try again').disabled).toBe(true)
      expect(packageOperation).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        finish()
        await pending
      })
    }
  }
)
