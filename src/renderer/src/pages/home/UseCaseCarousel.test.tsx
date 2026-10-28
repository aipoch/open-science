// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within } from '@testing-library/dom'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { parseUseCases } from '../../../../shared/use-cases'
import { UseCaseCarousel } from './UseCaseCarousel'
import { useUseCaseGalleryStore } from './use-case-gallery-store'
import { usePackageOperationStore } from '@/stores/package-operation-store'

let container: HTMLDivElement
let root: Root
const items = Array.from({ length: 7 }, (_, index) => ({
  name: `case-${index + 1}`,
  title: `Case ${index + 1}`,
  cover: { file_name: 'cover.png' },
  case: { file_name: 'case.science', bytes: 3, sha256: 'a'.repeat(64) }
}))
beforeEach(() => {
  useUseCaseGalleryStore.setState(useUseCaseGalleryStore.getInitialState(), true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  usePackageOperationStore.getState().receive(null)
  usePackageOperationStore.setState({ open: false })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected renderer fetch')))
  vi.stubGlobal('api', {
    sessions: {
      importPackage: vi.fn(async () => null),
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

it('shows three cards and cycles both ways including the incomplete final group', async () => {
  await render()
  const ui = within(container)
  expect(ui.getAllByRole('article')).toHaveLength(3)
  expect(ui.getByText('Case 1')).toBeTruthy()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.getByText('Case 4')).toBeTruthy()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.getByText('Case 7')).toBeTruthy()
  expect(ui.getAllByRole('article')).toHaveLength(3)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.getByText('Case 1')).toBeTruthy()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Previous examples' })))
  expect(ui.getByText('Case 7')).toBeTruthy()
})

it('links to the case slug and imports directly without a file picker or destination', async () => {
  await render()
  const card = within(within(container).getAllByRole('article')[0])
  expect(card.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe(
    'https://aipoch.com/open-science/use-cases/case-1'
  )
  await act(async () => fireEvent.click(card.getByRole('button', { name: 'Import' })))
  expect(window.api.sessions.importPackage).toHaveBeenCalledWith({}, { useCase: 'case-1' })
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

it('selects three distinct random cards and keeps paging usable', async () => {
  await render()
  const ui = within(container)
  const original = ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Random examples' })))
  const shuffled = ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))
  expect(new Set(shuffled).size).toBe(3)
  expect(shuffled).not.toEqual(original)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.getAllByRole('article')).toHaveLength(3)
})

it('retains a download on its card across carousel navigation and cancels by operation identity', async () => {
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
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.queryByRole('progressbar')).toBeNull()
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Previous examples' })))
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
  const ui = within(container)
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
  const active = within(ui.getAllByRole('article')[0]).getByRole('button', {
    name: 'Import'
  }) as HTMLButtonElement
  expect(active.disabled).toBe(true)
  expect(active.getAttribute('aria-busy')).toBe('true')
  await act(async () => store.receive({ ...waiting, id: 'unrelated-import' }))
  expect(ui.queryByRole('button', { name: 'Continue' })).toBeNull()
})

it('changes the displayed order when a small catalog shuffles to the same order', async () => {
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(items.slice(0, 3)))
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.999)
  try {
    await render()
    const ui = within(container)
    const before = ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))
    await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Random examples' })))
    expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).not.toEqual(
      before
    )
  } finally {
    random.mockRestore()
  }
})

it('restores the browsed cards immediately after returning, even while catalog requests are pending', async () => {
  await render()
  const ui = within(container)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  await act(async () => root.render(null))
  vi.mocked(window.api.sessions.useCaseCatalog).mockImplementation(() => new Promise(() => {}))
  await render()
  expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
    'Case 4',
    'Case 5',
    'Case 6'
  ])
})

it('restores a shuffled group and its paging position after returning', async () => {
  await render()
  const ui = within(container)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Random examples' })))
  const selected = ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))
  await act(async () => root.render(null))
  await render()
  expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(
    selected
  )
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  expect(ui.getByText('Case 7')).toBeTruthy()
})

it('updates retained cards by identity and only replaces a removed slot when the catalog changes', async () => {
  await render()
  const ui = within(container)
  await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Next examples' })))
  await act(async () => root.render(null))
  const refreshed = [items[6], items[5], items[3], items[2], items[1], items[0]].map((item) => ({
    ...item,
    title: item.title + ' updated'
  }))
  vi.mocked(window.api.sessions.useCaseCatalog).mockResolvedValue(parseUseCases(refreshed))
  await render()
  expect(ui.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
    'Case 4 updated',
    'Case 7 updated',
    'Case 6 updated'
  ])
})
