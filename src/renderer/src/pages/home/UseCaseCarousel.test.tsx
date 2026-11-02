// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/dom'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { parseUseCases } from '../../../../shared/use-cases'
import { UseCaseCarousel } from './UseCaseCarousel'
import { useNavigationStore } from '@/stores/navigation-store'
import { useUseCaseGalleryStore } from './use-case-gallery-store'
import { usePackageOperationStore } from '@/stores/package-operation-store'

let container: HTMLDivElement
let root: Root
let intersect: (isIntersecting: boolean) => void
const items = Array.from({ length: 7 }, (_, index) => ({
  name: `case-${index + 1}`,
  title: `Case ${index + 1}`,
  cover: { file_name: 'cover.png' },
  case: { file_name: 'case.science', bytes: 3, sha256: 'a'.repeat(64) }
}))
beforeEach(() => {
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
  useUseCaseGalleryStore.setState(useUseCaseGalleryStore.getInitialState(), true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = (isIntersecting) =>
          callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          )
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  usePackageOperationStore.getState().receive(null)
  usePackageOperationStore.setState({ open: false })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected renderer fetch')))
  vi.stubGlobal('api', {
    sessions: {
      importPackage: vi.fn(async () => null),
      useCaseIntroduction: vi.fn(async () => '# Published findings\n\nA reproducible example.'),
      useCaseCatalog: vi.fn(async () => parseUseCases(items))
    }
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async (): Promise<void> => {
  await act(async () => root.render(<UseCaseCarousel />))
}

it('appends six cards at the scroll boundary, preserves existing cards and stops at the catalog end', async () => {
  const catalog = Array.from({ length: 19 }, (_, index) => ({
    ...items[0],
    name: `case-${index + 1}`,
    title: `Case ${index + 1}`
  }))
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(catalog))
  await render()
  const ui = within(container)
  expect(ui.getAllByRole('article')).toHaveLength(6)
  expect(ui.queryByRole('button', { name: 'Next examples' })).toBeNull()
  expect(ui.queryByRole('button', { name: 'Previous examples' })).toBeNull()
  const first = ui.getAllByRole('article')[0]
  await act(async () => intersect(false))
  expect(ui.getAllByRole('article')).toHaveLength(6)
  for (const count of [12, 18, 19]) {
    await act(async () => intersect(true))
    expect(ui.getAllByRole('article')).toHaveLength(count)
    expect(ui.getAllByRole('article')[0]).toBe(first)
  }
  await act(async () => intersect(true))
  expect(ui.getAllByRole('article')).toHaveLength(19)
  expect(
    new Set(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).size
  ).toBe(19)
})

it('opens details inside the app and imports through the existing flow', async () => {
  await render()
  const card = within(within(container).getAllByRole('article')[0])
  await act(async () => fireEvent.click(card.getByRole('button', { name: 'Case 1' })))
  const dialog = within(within(document.body).getByRole('dialog', { name: 'Case details' }))
  expect(dialog.getByText('A reproducible example.')).toBeTruthy()
  expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledWith('case-1')
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Import' })))
  expect(window.api.sessions.importPackage).toHaveBeenCalledWith({}, { useCase: 'case-1' })
})

it('routes the gallery title and detail marketplace action to the marketplace page', async () => {
  await render()
  await act(async () =>
    fireEvent.click(within(container).getByRole('button', { name: 'Use Case Marketplace' }))
  )
  expect(useNavigationStore.getState().view).toBe('marketplace')
  expect(within(document.body).queryByRole('dialog')).toBeNull()
  await act(async () => fireEvent.click(within(container).getByRole('button', { name: 'Case 1' })))
  const dialog = within(within(document.body).getByRole('dialog'))
  expect(dialog.queryByRole('button', { name: 'Back to examples' })).toBeNull()
  await act(async () =>
    fireEvent.click(dialog.getByRole('button', { name: 'Go to Use Case Marketplace' }))
  )
  expect(useNavigationStore.getState().view).toBe('marketplace')
  expect(within(document.body).queryByRole('dialog')).toBeNull()
})

it('hides the gallery silently when no catalog is available', async () => {
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue([])
  await render()
  expect(container.textContent).toBe('')
})

it('shows the cache before a silent refresh and retains the active download', async () => {
  let finish!: (items: ReturnType<typeof parseUseCases>) => void
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(async (mode) =>
    mode === 'cached'
      ? parseUseCases(items)
      : new Promise((resolve) => {
          finish = resolve
        })
  )
  usePackageOperationStore.getState().receive({
    id: 'download',
    kind: 'import',
    state: 'running',
    progress: { phase: 'copying' },
    useCaseDownload: { slug: 'case-1', completedBytes: 35, totalBytes: 100 }
  })
  await render()
  expect(within(container).getByText('Case 1')).toBeTruthy()
  await act(async () =>
    finish(parseUseCases(items.map((item) => ({ ...item, title: item.title + ' updated' }))))
  )
  expect(within(container).getByText('Case 1 updated')).toBeTruthy()
  expect(within(container).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35')
})

it('retains a download on its card while appending and cancels by operation identity', async () => {
  const packageOperation = vi.fn(async () => null)
  vi.stubGlobal('api', {
    sessions: {
      importPackage: vi.fn(),
      packageOperation,
      useCaseCatalog: vi.fn(async () => parseUseCases(items))
    }
  })
  usePackageOperationStore.getState().receive({
    id: 'download',
    kind: 'import',
    state: 'running',
    progress: { phase: 'copying' },
    useCaseDownload: { slug: 'case-1', completedBytes: 35, totalBytes: 100 }
  })
  await render()
  const ui = within(container)
  const progress = ui.getByRole('progressbar')
  expect(progress.getAttribute('aria-valuenow')).toBe('35')
  expect(usePackageOperationStore.getState().open).toBe(false)
  await act(async () => intersect(true))
  expect(ui.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35')
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Cancel' })))
  expect(packageOperation).toHaveBeenCalledWith({ action: 'cancel', operationId: 'download' })
})

it('reopens the owning import after download and keeps waiting separate from active work', async () => {
  const store = usePackageOperationStore.getState()
  store.receive({
    id: 'example-import',
    kind: 'import',
    state: 'running',
    progress: { phase: 'copying' },
    useCaseDownload: { slug: 'case-1', completedBytes: 100, totalBytes: 100 }
  })
  // Mount after the handoff to cover returning to the homepage during project selection.
  const waiting = {
    id: 'example-import',
    kind: 'import' as const,
    state: 'awaiting-selection' as const,
    progress: { phase: 'selecting' as const }
  }
  store.receive(waiting)
  store.setOpen(false)
  await render()
  await act(async () => fireEvent.click(within(container).getByRole('button', { name: 'Case 1' })))
  const ui = within(within(document.body).getByRole('dialog'))
  const resume = ui.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
  expect(resume.disabled).toBe(false)
  expect(resume.getAttribute('aria-busy')).toBe('false')
  await act(async () => fireEvent.click(resume))
  expect(usePackageOperationStore.getState().open).toBe(true)
  expect(window.api.sessions.importPackage).not.toHaveBeenCalled()
  await act(async () =>
    store.receive({ ...waiting, state: 'running', progress: { phase: 'importing' } })
  )
  expect(ui.queryByRole('button', { name: 'Continue' })).toBeNull()
  const active = ui.getByRole('button', { name: 'Importing…' }) as HTMLButtonElement
  expect(active.disabled).toBe(true)
  expect(active.getAttribute('aria-busy')).toBe('true')
  await act(async () => store.receive({ ...waiting, id: 'unrelated-import' }))
  expect(ui.queryByRole('button', { name: 'Continue' })).toBeNull()
})

it('restores the browsed cards immediately after returning, even while catalog requests are pending', async () => {
  await render()
  const ui = within(container)
  await act(async () => intersect(true))
  await act(async () => root.render(null))
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(() => new Promise(() => {}))
  await render()
  expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
    'Case 1',
    'Case 2',
    'Case 3',
    'Case 4',
    'Case 5',
    'Case 6',
    'Case 7'
  ])
})

it('updates retained cards by identity and only replaces a removed slot when the catalog changes', async () => {
  await render()
  const ui = within(container)
  await act(async () => intersect(true))
  await act(async () => root.render(null))
  const refreshed = [items[6], items[5], items[3], items[2], items[1], items[0]].map((item) => ({
    ...item,
    title: item.title + ' updated'
  }))
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(refreshed))
  await render()
  expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
    'Case 1 updated',
    'Case 2 updated',
    'Case 3 updated',
    'Case 4 updated',
    'Case 6 updated',
    'Case 7 updated'
  ])
})

it('filters marketplace cards with visible category buttons combined with search', async () => {
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(
    parseUseCases(
      items.map((item, index) => ({
        ...item,
        catalog: index % 2 ? 'Biology' : 'Science',
        catalog_name: index % 2 ? 'biology' : 'science'
      }))
    )
  )
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  expect(ui.queryByRole('combobox')).toBeNull()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Biology' })))
  expect(ui.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual([
    'Case 2',
    'Case 4',
    'Case 6'
  ])
  expect(ui.getByRole('button', { name: 'Biology' }).getAttribute('aria-pressed')).toBe('true')
  await act(async () =>
    fireEvent.change(ui.getByRole('textbox', { name: 'Search examples' }), {
      target: { value: 'Case 4' }
    })
  )
  expect(ui.getAllByRole('article')).toHaveLength(1)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Science' })))
  expect(ui.queryAllByRole('article')).toHaveLength(0)
  expect(ui.getByText('No matching examples')).toBeTruthy()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'All categories' })))
  expect(ui.getAllByRole('article')[0].getAttribute('aria-label')).toBe('Case 4')
})

it('keeps details open while downloading, cancelling and retrying an example import', async () => {
  const downloading = {
    id: 'detail-download',
    kind: 'import' as const,
    state: 'running' as const,
    progress: { phase: 'copying' as const },
    useCaseDownload: { slug: 'case-1', completedBytes: 35, totalBytes: 100 }
  }
  vi.mocked(window.api.sessions.importPackage).mockImplementation(async () => {
    usePackageOperationStore.getState().receive(downloading)
    return null
  })
  window.api.sessions.packageOperation = vi.fn(async () => {
    usePackageOperationStore.getState().receive({ ...downloading, state: 'cancelled' })
    return null
  })
  await render()
  await act(async () => fireEvent.click(within(container).getByRole('button', { name: 'Case 1' })))
  let dialog = within(within(document.body).getByRole('dialog', { name: 'Case details' }))
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Import' })))
  dialog = within(within(document.body).getByRole('dialog', { name: 'Case details' }))
  expect(dialog.getByRole('button', { name: 'Downloading 35%' })).toBeTruthy()
  expect(dialog.queryByRole('progressbar')).toBeNull()
  expect(dialog.getByRole('button', { name: 'Downloading 35%' }).hasAttribute('disabled')).toBe(
    true
  )
  await act(async () =>
    usePackageOperationStore.getState().receive({
      ...downloading,
      useCaseDownload: { slug: 'case-1', completedBytes: 100, totalBytes: 100 }
    })
  )
  expect(dialog.getByRole('button', { name: 'Verifying download…' })).toBeTruthy()
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Cancel' })))
  expect(dialog.queryByRole('progressbar')).toBeNull()
  expect(dialog.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(false)
  await act(async () =>
    usePackageOperationStore.getState().receive({ ...downloading, state: 'failed' })
  )
  expect(dialog.getByText('Could not download this example. Try again.')).toBeTruthy()
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Try again' })))
  expect(dialog.getByRole('button', { name: 'Downloading 35%' })).toBeTruthy()
  expect(dialog.queryByRole('progressbar')).toBeNull()
})

it('prefetches only a settled hover and shares that request with the opened detail', async () => {
  vi.useFakeTimers()
  let finish!: (content: string) => void
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(
    parseUseCases(items.map((item) => ({ ...item, introduction: { file_name: 'Intro.md' } })))
  )
  vi.mocked(window.api.sessions.useCaseIntroduction).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  try {
    await render()
    const cards = within(container).getAllByRole('article')
    await act(async () => {
      fireEvent.mouseOver(cards[0])
      await vi.advanceTimersByTimeAsync(100)
      fireEvent.mouseOut(cards[0])
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(window.api.sessions.useCaseIntroduction).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.mouseOver(cards[0])
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.mouseOver(cards[1])
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledTimes(1)
    await act(async () => fireEvent.click(within(cards[0]).getByRole('button', { name: 'Case 1' })))
    expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledTimes(1)
    await act(async () => finish('# Prefetched findings'))
    const dialog = within(within(document.body).getByRole('dialog'))
    expect(dialog.getByRole('heading', { name: 'Prefetched findings' })).toBeTruthy()
    await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Close' })))
    await act(async () => fireEvent.click(within(cards[0]).getByRole('button', { name: 'Case 1' })))
    expect(within(document.body).queryByText('Loading introduction…')).toBeNull()
    expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it('opens the case from its whole card and offers marketplace navigation beside detail import', async () => {
  await render()
  const ui = within(container)
  expect(ui.getByRole('button', { name: 'Use Case Marketplace' })).toBeTruthy()
  expect(ui.queryByRole('button', { name: 'Random examples' })).toBeNull()
  const card = within(ui.getAllByRole('article')[0])
  expect(card.queryByRole('button', { name: 'Details' })).toBeNull()
  expect(card.queryByRole('button', { name: 'Import' })).toBeNull()
  await act(async () => fireEvent.click(card.getByRole('button', { name: 'Case 1' })))
  const dialog = within(within(document.body).getByRole('dialog', { name: 'Case details' }))
  expect(dialog.getByRole('button', { name: 'Import' })).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'View more' })).toBeNull()
  await act(async () =>
    fireEvent.click(dialog.getByRole('button', { name: 'Go to Use Case Marketplace' }))
  )
  expect(useNavigationStore.getState().view).toBe('marketplace')
})

it('opens workbench marketplace details inline and returns to the retained list', async () => {
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" compact />))
  const ui = within(container)
  await act(async () =>
    fireEvent.input(ui.getByRole('textbox', { name: 'Search examples' }), {
      target: { value: 'Case 1' }
    })
  )
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Case 1' })))
  expect(within(document.body).queryByRole('dialog')).toBeNull()
  const details = within(ui.getByRole('region', { name: 'Case details' }))
  expect(details.queryByRole('button', { name: 'Go to Use Case Marketplace' })).toBeNull()
  expect(details.getByRole('button', { name: 'Import' })).toBeTruthy()
  await act(async () => fireEvent.click(details.getByRole('button', { name: 'Back to list' })))
  expect(ui.queryByRole('region', { name: 'Case details' })).toBeNull()
  expect(ui.getByRole('textbox', { name: 'Search examples' })).toHaveProperty('value', 'Case 1')
  expect(ui.getAllByRole('article')).toHaveLength(1)
})

it('keeps cached cards on failure and shows completion on the refresh button', async () => {
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  let finish!: (items: ReturnType<typeof parseUseCases>) => void
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const refresh = ui.getByRole('button', { name: 'Refresh examples' }) as HTMLButtonElement
  await act(async () => fireEvent.click(refresh))
  expect(refresh.disabled).toBe(true)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(ui.getAllByRole('article')).toHaveLength(6)
  expect(window.api.sessions.useCaseCatalog).toHaveBeenLastCalledWith('reload')
  await act(async () =>
    finish(parseUseCases(items.map((item) => ({ ...item, title: `Updated ${item.title}` }))))
  )
  expect(ui.getByRole('button', { name: 'Updated Case 1' })).toBeTruthy()
  expect(refresh.disabled).toBe(false)
  expect(refresh.querySelector('.lucide-check')).not.toBeNull()
  vi.mocked(window.api.sessions.useCaseCatalog).mockRejectedValueOnce(new Error('offline'))
  await act(async () => fireEvent.click(refresh))
  expect(ui.queryByRole('status')).toBeNull()
  expect(ui.queryByRole('alert')).toBeNull()
  expect(refresh.querySelector('.lucide-check')).not.toBeNull()
  expect(ui.getByRole('button', { name: 'Updated Case 1' })).toBeTruthy()
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(items))
  await act(async () => fireEvent.click(refresh))
  expect(ui.queryByRole('alert')).toBeNull()
  expect(ui.getByRole('button', { name: 'Case 1' })).toBeTruthy()
})

it.each([false, true])(
  'retries only failed covers on manual refresh (catalog failure: %s)',
  async (catalogFailure) => {
    await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
    const ui = within(container)
    const images = container.querySelectorAll('article img')
    const failed = images[0] as HTMLImageElement
    const healthy = images[1] as HTMLImageElement
    const originalFailedSource = failed.src
    const healthySource = healthy.src
    await act(async () => {
      fireEvent.error(failed)
      fireEvent.load(healthy)
    })
    if (catalogFailure)
      vi.mocked(window.api.sessions.useCaseCatalog).mockRejectedValue(new Error('offline'))
    const refresh = ui.getByRole('button', { name: 'Refresh examples' })
    await act(async () => fireEvent.click(refresh))
    const retried = container.querySelector('article img') as HTMLImageElement
    expect(retried.src).not.toBe(originalFailedSource)
    expect(container.querySelectorAll('article img')[1]).toBe(healthy)
    expect(healthy.src).toBe(healthySource)
    expect(healthy.className).toContain('opacity-100')
    const retrySource = retried.src
    await act(async () => fireEvent.error(retried))
    expect(retried.src).toBe(retrySource)
    await act(async () => fireEvent.click(refresh))
    expect((container.querySelector('article img') as HTMLImageElement).src).not.toBe(retrySource)
  }
)

it('keeps standalone marketplace details in a dialog without replacing the list', async () => {
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Case 1' })))
  const dialog = within(within(document.body).getByRole('dialog', { name: 'Case details' }))
  expect(dialog.getByRole('button', { name: 'Import' })).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Back to list' })).toBeNull()
  expect(ui.queryByRole('region', { name: 'Case details' })).toBeNull()
  expect(ui.getAllByRole('article', { hidden: true })).toHaveLength(6)
  await act(async () => fireEvent.click(dialog.getByRole('button', { name: 'Close' })))
  expect(within(document.body).queryByRole('dialog')).toBeNull()
  expect(ui.getAllByRole('article')).toHaveLength(6)
})

it.each(['success', 'failure'] as const)(
  'restores the refresh icon two seconds after %s without a notice',
  async (outcome) => {
    vi.useFakeTimers()
    try {
      await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
      const ui = within(container)
      const refresh = ui.getByRole('button', { name: 'Refresh examples' })
      if (outcome === 'failure')
        vi.mocked(window.api.sessions.useCaseCatalog).mockRejectedValue(new Error('offline'))
      expect(refresh.querySelector('.lucide-refresh-cw')).not.toBeNull()
      await act(async () => fireEvent.click(refresh))
      expect(refresh.querySelector('.lucide-check')).not.toBeNull()
      expect(ui.queryByRole('status')).toBeNull()
      expect(ui.queryByRole('alert')).toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(1500))
      await act(async () => fireEvent.click(refresh))
      await act(async () => vi.advanceTimersByTimeAsync(1500))
      expect(refresh.querySelector('.lucide-check')).not.toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(refresh.querySelector('.lucide-check')).toBeNull()
      expect(refresh.querySelector('.lucide-refresh-cw')).not.toBeNull()
      expect(ui.getAllByRole('article')).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  }
)

it('defaults the workbench market selector to cases while keeping category controls separate', async () => {
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" compact />))
  const ui = within(container)
  const selector = ui.getByRole('combobox', { name: 'Marketplace' })
  expect(selector.textContent).toContain('Use Case Marketplace')
  expect(ui.getByRole('group', { name: 'Category' })).toBeTruthy()
  expect(ui.getAllByRole('article')).toHaveLength(6)
})

it('updates an already open detail after another gallery refreshes without clearing its content', async () => {
  const catalog = parseUseCases(
    items.map((item) => ({ ...item, introduction: { file_name: 'intro.md' } }))
  )
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(catalog)
  await act(async () =>
    root.render(
      <>
        <UseCaseCarousel variant="marketplace" compact />
        <UseCaseCarousel />
      </>
    )
  )
  const ui = within(container)
  await act(async () => fireEvent.click(ui.getAllByRole('button', { name: 'Case 1' })[0]))
  const details = ui.getByRole('region', { name: 'Case details' })
  expect(within(details).getByText('A reproducible example.')).toBeTruthy()
  let finish!: (body: string) => void
  vi.mocked(window.api.sessions.useCaseIntroduction).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => useUseCaseGalleryStore.getState().receive(catalog, true))
  expect(within(details).getByText('A reproducible example.')).toBeTruthy()
  expect(within(details).queryByText('Loading introduction…')).toBeNull()
  expect(window.api.sessions.useCaseIntroduction).toHaveBeenCalledTimes(2)
  await act(async () => finish('# Updated findings'))
  expect(within(details).getByText('Updated findings')).toBeTruthy()
  expect(ui.getByRole('region', { name: 'Case details' })).toBe(details)
})

it('distinguishes initial loading, failure, retry and a successfully empty marketplace', async () => {
  let fail!: (error: Error) => void
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(async (mode) =>
    mode === 'cached'
      ? []
      : new Promise((_, reject) => {
          fail = reject
        })
  )
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  expect(ui.getByRole('status').textContent).toContain('Loading examples…')
  expect(ui.queryByText('No matching examples')).toBeNull()
  await act(async () => fail(new Error('offline')))
  expect(ui.getByRole('alert').textContent).toContain('Could not load examples. Try again.')
  expect(ui.queryByText('No matching examples')).toBeNull()
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue([])
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Try again' })))
  expect(ui.getByText('No examples available yet.')).toBeTruthy()
  expect(ui.queryByRole('alert')).toBeNull()
})

it('keeps cached cards visible if the initial network check fails', async () => {
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(async (mode) => {
    if (mode === 'cached') return parseUseCases(items)
    throw new Error('offline')
  })
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  expect(ui.getAllByRole('article')).toHaveLength(6)
  expect(ui.queryByRole('alert')).toBeNull()
  expect(ui.queryByRole('status')).toBeNull()
})

it('clears a removed category after refresh without clearing search or reselecting it later', async () => {
  const categorized = items.map((item, index) => ({
    ...item,
    catalog: index % 2 ? 'Biology' : 'Science',
    catalog_name: index % 2 ? 'biology' : 'science'
  }))
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(categorized))
  await act(async () => root.render(<UseCaseCarousel variant="marketplace" />))
  const ui = within(container)
  await act(async () =>
    fireEvent.input(ui.getByRole('textbox', { name: 'Search examples' }), {
      target: { value: 'Case 2' }
    })
  )
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Biology' })))
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(
    parseUseCases(
      categorized.map((item) => ({ ...item, catalog: 'Science', catalog_name: 'science' }))
    )
  )
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Refresh examples' })))
  expect(ui.getByRole('button', { name: 'All categories' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(ui.queryByRole('button', { name: 'Biology' })).toBeNull()
  expect(ui.getByRole('textbox', { name: 'Search examples' })).toHaveProperty('value', 'Case 2')
  expect(ui.getByRole('article', { name: 'Case 2' })).toBeTruthy()
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(categorized))
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Refresh examples' })))
  expect(ui.getByRole('button', { name: 'All categories' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(ui.getByRole('button', { name: 'Biology' }).getAttribute('aria-pressed')).toBe('false')
})
