// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { PdfFiguresView } from './PdfFiguresView'
import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'
import type { LocalModelSnapshot } from '../../../../../../shared/local-models'
import { LOCAL_MODEL_NOT_INSTALLED } from '../../../../../../shared/local-models'

const result: PdfStructureResult = {
  schemaVersion: 1,
  extractionId: 'result-1',
  engineFingerprint: 'a'.repeat(64),
  sourceChecksum: 'b'.repeat(64),
  sourceSizeBytes: 1,
  pageCount: 2,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
  elements: [
    {
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
      thumbnailId: 'table-1',
      caption: {
        text: 'Table 1. Original caption.',
        regions: [{ page: 1, x: 0, y: 0, width: 1, height: 0.1 }]
      },
      issues: [],
      table: {
        rowCount: 2,
        columnCount: 2,
        cells: [
          { row: 0, column: 0, rowSpan: 1, columnSpan: 2, text: 'Merged header', regions: [] },
          { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: 'Value', regions: [] }
        ],
        unassignedText: [],
        issues: []
      }
    }
  ],
  thumbnails: [],
  navigation: [],
  issues: []
}
let model: LocalModelSnapshot
let container: HTMLDivElement, root: Root
const api = {
  localModels: {
    getSnapshot: vi.fn(async () => model),
    install: vi.fn(async () => model),
    cancel: vi.fn(async () => model)
  },
  pdfStructure: {
    parse: vi.fn(),
    cancel: vi.fn(async () => undefined),
    readThumbnail: vi.fn(async () => 'data:image/png;base64,eA=='),
    clearCache: vi.fn(async () => ({ removedBytes: 0, retainedEntries: 0 }))
  }
}
const clipboard = vi.fn(async () => undefined),
  navigate = vi.fn()
const click = async (text: string): Promise<void> => {
  const buttons = [...container.querySelectorAll('button')]
  const button =
    buttons.find((b) => b.textContent === text) ??
    buttons.find((b) => b.textContent?.includes(text))
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
beforeEach(async () => {
  vi.clearAllMocks()
  await i18next.changeLanguage('en')
  model = {
    availability: 'ready',
    recommendedRevision: 'v1',
    installedRevision: 'v1',
    downloadBytes: 10,
    installedBytes: 10,
    hasFiles: true,
    inUse: false,
    transferredBytes: 0,
    updateAvailable: false
  }
  vi.stubGlobal('api', api)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('waits for asynchronous model installation before continuing extraction', async () => {
  vi.useFakeTimers()
  model = { ...model, availability: 'notInstalled', installedRevision: undefined }
  api.localModels.install.mockImplementationOnce(async () => {
    const installing = { ...model, availability: 'installing' as const }
    model = { ...model, availability: 'ready', installedRevision: 'v1' }
    return installing
  })
  api.pdfStructure.parse
    .mockRejectedValueOnce(new Error(LOCAL_MODEL_NOT_INSTALLED))
    .mockResolvedValue(result)
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Download and continue')
  expect(api.pdfStructure.parse).toHaveBeenCalledOnce()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(api.pdfStructure.parse).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('PDF extraction is unavailable')
})
it('opens cached results without reinstalling a removed model package', async () => {
  model = { ...model, availability: 'notInstalled', installedRevision: undefined }
  api.pdfStructure.parse.mockResolvedValue(result)
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Download and continue')
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(container.textContent).toContain('TablePage 1')
})
it('shows download activity and byte progress, then switches to PDF processing', async () => {
  vi.useFakeTimers()
  model = {
    ...model,
    availability: 'notInstalled',
    installedRevision: undefined,
    downloadBytes: 100 * 1024 ** 2
  }
  api.localModels.install.mockImplementationOnce(async () => {
    model = { ...model, availability: 'installing', transferredBytes: 44 * 1024 ** 2 }
    return model
  })
  api.pdfStructure.parse
    .mockRejectedValueOnce(new Error(LOCAL_MODEL_NOT_INSTALLED))
    .mockImplementationOnce(() => new Promise(() => {}))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Download and continue')
  expect(container.textContent).toContain('Downloading and verifying…')
  expect(container.textContent).toContain('44.0 MiB / 100.0 MiB')
  expect(container.textContent).not.toContain('Browse figures, captions and copyable tables.')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('44')
  model = { ...model, availability: 'ready', installedRevision: 'v1' }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(container.textContent).toContain('Analyzing PDF…')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
    'PDF extraction progress'
  )
  await click('Cancel')
  expect(container.querySelector('[role="progressbar"]')).toBeNull()
})
it('does not download a model after an unrelated source failure', async () => {
  model = { ...model, availability: 'notInstalled', installedRevision: undefined }
  api.pdfStructure.parse.mockRejectedValue(new Error('Source permission denied'))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Download and continue')
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Could not extract pages: 1')
})
it('joins cancellation of an install that returns after Cancel before starting another run', async () => {
  model = { ...model, availability: 'notInstalled', installedRevision: undefined }
  api.pdfStructure.parse.mockRejectedValue(new Error(LOCAL_MODEL_NOT_INSTALLED))
  let finishInstall!: (value: LocalModelSnapshot) => void
  api.localModels.install.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishInstall = resolve
      })
  )
  let finishCancel!: () => void
  api.localModels.cancel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCancel = () => resolve(model)
      })
  )
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Download and continue')
  await click('Cancel')
  await click('Download and continue')
  expect(api.localModels.install).toHaveBeenCalledOnce()
  await act(async () => finishInstall({ ...model, availability: 'installing' }))
  expect(api.localModels.cancel).toHaveBeenCalledOnce()
  expect(api.localModels.install).toHaveBeenCalledOnce()
  api.pdfStructure.parse.mockResolvedValue(result)
  await act(async () => finishCancel())
  expect(api.localModels.install).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('TablePage 1')
})
it('does not cancel the global download when an old document unmounts during installation', async () => {
  model = { ...model, availability: 'notInstalled', installedRevision: undefined }
  api.pdfStructure.parse.mockRejectedValue(new Error(LOCAL_MODEL_NOT_INSTALLED))
  let finish!: (value: LocalModelSnapshot) => void
  api.localModels.install.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    root.render(<PdfFiguresView attachmentVersionId="old" pageCount={1} onNavigate={navigate} />)
  )
  await click('Download and continue')
  await act(async () =>
    root.render(
      <PdfFiguresView key="new" attachmentVersionId="new" pageCount={1} onNavigate={navigate} />
    )
  )
  api.pdfStructure.parse.mockResolvedValue(result)
  await click('Download and continue')
  await act(async () => finish({ ...model, availability: 'installing' }))
  expect(api.localModels.cancel).not.toHaveBeenCalled()
  expect(container.textContent).toContain('TablePage 1')
})

it('shows partial coverage, original caption, merged cells and review-gated copy', async () => {
  api.pdfStructure.parse
    .mockResolvedValueOnce(result)
    .mockRejectedValueOnce(new Error('unsupported page'))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(container.textContent).toContain('Could not extract pages: 2')
  await click('TablePage 1')
  expect(container.querySelector('td[colspan="2"]')?.textContent).toBe('Merged header')
  expect(container.textContent).toContain('[Missing]')
  expect(container.textContent).toContain('Table 1. Original caption.')
  const copy = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy TSV')!
  expect(copy.disabled).toBe(true)
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  )
  await click('Copy TSV')
  expect(clipboard).toHaveBeenCalledWith('Merged header\t\nValue\t[Missing]')
  await click('Show in PDF')
  expect(navigate).toHaveBeenCalledWith(1)
  await click('Image')
  expect(container.querySelector('table')).toBeNull()
  expect(container.querySelector('img')).not.toBeNull()
  await click('Table')
  expect(container.querySelector('td[colspan="2"]')).not.toBeNull()
})

it('copies an HTML table and plain text together with separate notes after review', async () => {
  class Item {
    constructor(readonly data: Record<string, Blob>) {}
  }
  const write = vi.fn<(items: Item[]) => Promise<void>>().mockResolvedValue(undefined)
  vi.stubGlobal('ClipboardItem', Item)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write, writeText: clipboard }
  })
  const table = result.elements[0].table!
  api.pdfStructure.parse.mockResolvedValue({
    ...result,
    elements: [
      {
        ...result.elements[0],
        table: {
          ...table,
          notes: [{ text: '* Original note.', regions: result.elements[0].regions }]
        }
      }
    ]
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(container.textContent).toContain('Table notes')
  await click('Copy formatted table')
  expect(write).not.toHaveBeenCalled()
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  )
  await click('Copy formatted table')
  expect(write).toHaveBeenCalledOnce()
  const item = write.mock.calls[0][0][0]
  expect(item.data['text/html'].type).toBe('text/html')
  expect(item.data['text/plain'].type).toBe('text/plain')
  const readBlob = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(blob)
    })
  expect(await readBlob(item.data['text/html'])).toContain('colspan="2"')
  expect(await readBlob(item.data['text/html'])).toContain('<p>* Original note.</p>')
  expect(await readBlob(item.data['text/plain'])).toContain(
    'Merged header\t\nValue\t[Missing]\n\n* Original note.'
  )
  expect(clipboard).not.toHaveBeenCalled()
})

it('processes a document longer than 100 pages through sequential bounded requests', async () => {
  api.pdfStructure.parse.mockImplementation(async ({ page }: { page: number }) => ({
    ...result,
    pageCount: 101,
    requestedPages: [page],
    processedPages: [page],
    elements: [],
    pages: [{ ...result.pages[0], page }]
  }))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={101} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(api.pdfStructure.parse).toHaveBeenCalledTimes(101)
  expect(api.pdfStructure.parse.mock.calls.at(-1)?.[0].page).toBe(101)
  expect(container.textContent).toContain('Analysis complete')
})

it('explains unplaced text and excludes it from copying without repeating the warning in image view', async () => {
  const element = result.elements[0]
  api.pdfStructure.parse.mockResolvedValue({
    ...result,
    elements: [
      {
        ...element,
        issues: [{ code: 'unassigned-source-text', detail: '' }],
        table: { ...element.table!, unassignedText: [{ text: 'Uncertain header', regions: [] }] }
      }
    ]
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(container.textContent).toContain('Unplaced table text')
  expect(container.textContent).toContain('This text is not included when copying the table.')
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  )
  await click('Copy TSV')
  expect(clipboard).toHaveBeenCalledWith('Merged header\t\nValue\t[Missing]')
  await click('Image')
  expect(container.textContent).not.toContain('Review it below')
  expect(container.textContent).not.toContain('Unplaced table text')
  expect(container.textContent).toContain('Check extracted content against the original PDF.')
})
it('cancels an active source request and ignores its late result', async () => {
  let finish!: (value: PdfStructureResult) => void
  api.pdfStructure.parse.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  await click('Cancel')
  expect(api.pdfStructure.cancel).toHaveBeenCalledOnce()
  await act(async () => finish(result))
  expect(api.pdfStructure.parse).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('Table 1. Original caption.')
})

it('presents an empty successful analysis as complete without an initial analysis prompt', async () => {
  api.pdfStructure.parse.mockResolvedValue({ ...result, elements: [] })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(api.pdfStructure.parse).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Analysis complete')
  expect(container.querySelector('h3')?.textContent).toBe('No figures or tables detected')
  expect(container.textContent).toContain('Processed 2 / 2 pages')
  expect(container.textContent).not.toContain('Analyze PDF')
  expect(container.textContent).not.toContain('Scanned and rotated pages')
  expect(container.textContent).not.toContain('Download size')
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'Analyze again'
  ])
  await click('Analyze again')
  expect(api.pdfStructure.parse).toHaveBeenCalledTimes(4)
})

it('does not label an empty analysis complete when one of the pages failed', async () => {
  api.pdfStructure.parse
    .mockResolvedValueOnce({ ...result, elements: [] })
    .mockRejectedValueOnce(new Error('unsupported page'))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(container.textContent).toContain('Could not extract pages: 2')
  expect(container.querySelector('h3')?.textContent).toBe('Analysis incomplete')
  expect(container.textContent).not.toContain('No figures or tables detected')
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
    'Analyze again'
  ])
})

it('keeps empty in-progress and cancelled runs distinct from successful completion', async () => {
  let finish!: (value: PdfStructureResult) => void
  api.pdfStructure.parse.mockResolvedValueOnce({ ...result, elements: [] }).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  expect(container.textContent).toContain('Analyzing PDF…')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel'])
  await click('Cancel')
  await act(async () => finish({ ...result, elements: [] }))
  expect(container.querySelector('h3')?.textContent).toBe('Analysis incomplete')
  expect(container.textContent).not.toContain('No figures or tables detected')
  expect(container.querySelector('[role="progressbar"]')).toBeNull()
})
