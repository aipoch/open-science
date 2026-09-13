// @vitest-environment jsdom
import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { PdfFiguresView } from './PdfFiguresView'
import { groupPdfFigureSelections } from './pdf-figure-selections'
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

it('groups adjacent figure pages with shared caption provenance and renders both image requests', async () => {
  const caption = {
    text: 'Figure 2. Complete legend.',
    regions: [{ page: 2, x: 0.1, y: 0.7, width: 0.8, height: 0.1 }]
  }
  const batches = [1, 2].map((page) => ({
    ...result,
    extractionId: `result-${page}`,
    requestedPages: [page],
    processedPages: [page],
    elements: [
      {
        ...result.elements[0],
        id: `figure-${page}`,
        kind: 'figure' as const,
        table: undefined,
        caption,
        thumbnailId: `figure-${page}`,
        regions: [{ page, x: 0.1, y: 0.1, width: 0.8, height: 0.5 }]
      }
    ]
  }))
  expect(groupPdfFigureSelections(batches)).toHaveLength(1)
  expect(groupPdfFigureSelections(batches)[0].continuations).toHaveLength(1)
  expect(
    groupPdfFigureSelections([
      batches[0],
      {
        ...batches[1],
        elements: [
          {
            ...batches[1].elements[0],
            caption: { ...caption, regions: [{ ...caption.regions[0], page: 3 }] }
          }
        ]
      }
    ])
  ).toHaveLength(2)
  api.pdfStructure.readCached.mockResolvedValueOnce(batches[0]).mockResolvedValueOnce(batches[1])
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version" pageCount={2} onNavigate={navigate} />
    )
  )
  expect(container.querySelectorAll('[data-pdf-image-frame]')).toHaveLength(2)
  expect(container.querySelectorAll('[data-pdf-caption]')).toHaveLength(1)
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledWith(
    expect.objectContaining({ page: 1, extractionId: 'result-1', thumbnailId: 'figure-1' })
  )
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledWith(
    expect.objectContaining({ page: 2, extractionId: 'result-2', thumbnailId: 'figure-2' })
  )
})
let model: LocalModelSnapshot
let container: HTMLDivElement, root: Root
const api = {
  saveBlobFile: vi.fn(async () => ({ saved: true })),
  localModels: {
    getSnapshot: vi.fn(async () => model),
    install: vi.fn(async () => model),
    cancel: vi.fn(async () => model)
  },
  pdfStructure: {
    readCached: vi.fn<() => Promise<PdfStructureResult | undefined>>().mockResolvedValue(undefined),
    parse: vi.fn(),
    cancel: vi.fn(async () => undefined),
    readThumbnail: vi.fn(async (): Promise<string | undefined> => 'data:image/png;base64,eA=='),
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
  api.localModels.getSnapshot.mockReset().mockImplementation(async () => model)
  api.pdfStructure.readCached.mockReset().mockResolvedValue(undefined)
  api.pdfStructure.readThumbnail.mockReset().mockResolvedValue('data:image/png;base64,eA==')
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

const showFigures = async (count = 1, firstNumber = 1): Promise<void> => {
  api.pdfStructure.parse.mockResolvedValue({
    ...result,
    elements: Array.from({ length: count }, (_, index) => ({
      ...result.elements[0],
      id: `figure-${index}`,
      kind: 'figure',
      table: undefined,
      thumbnailId: `figure-${index}`,
      caption: { ...result.elements[0].caption, text: `Figure ${index + firstNumber}. Caption.` }
    })),
    thumbnails: Array.from({ length: count }, (_, index) => ({
      id: `figure-${index}`,
      mimeType: 'image/png',
      width: 1200,
      height: 600,
      sizeBytes: 1,
      sha256: 'a'.repeat(64)
    }))
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
}

it('restores persisted results automatically when the tab opens and the preview reopens', async () => {
  api.pdfStructure.readCached.mockResolvedValue(result)
  const render = (active: boolean, key = 'first'): void =>
    root.render(
      <PdfFiguresView
        key={key}
        active={active}
        attachmentVersionId="version-1"
        pageCount={1}
        onNavigate={navigate}
      />
    )
  await act(async () => render(false))
  expect(api.pdfStructure.readCached).not.toHaveBeenCalled()
  await act(async () => render(true))
  expect(container.textContent).toContain('Merged header')
  expect(container.textContent).toContain('Analysis complete')
  await act(async () => render(true, 'reopened'))
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Merged header')
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
  expect(api.localModels.install).not.toHaveBeenCalled()
})

it('restores a completed empty result without offering the initial analysis action', async () => {
  api.pdfStructure.readCached.mockResolvedValue({ ...result, elements: [] })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  expect(container.textContent).toContain('Analysis complete')
  expect(
    [...container.querySelectorAll('button')].some((button) => button.textContent === 'Analyze PDF')
  ).toBe(false)
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('shows one cached table with independently copyable parts, shared notes and one image', async () => {
  const tableParts = [5, 7].map((columnCount, index) => ({
    title: index ? 'B. Dewa data' : 'A. Tricco data',
    table: {
      rowCount: 1,
      columnCount,
      cells: Array.from({ length: columnCount }, (_, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        columnSpan: 1,
        text: `${index ? 'B' : 'A'}${column}`,
        regions: []
      })),
      unassignedText: [],
      issues: []
    }
  }))
  api.pdfStructure.readCached.mockResolvedValue({
    ...result,
    elements: [
      {
        ...result.elements[0],
        table: undefined,
        tableParts,
        tableNotes: [{ text: 'Shared note', regions: [result.elements[0].regions[0]] }]
      }
    ]
  })
  const render = (key: string): void =>
    root.render(
      <PdfFiguresView
        key={key}
        attachmentVersionId="version-1"
        pageCount={1}
        onNavigate={navigate}
      />
    )
  await act(async () => render('first'))
  expect(container.querySelectorAll('table')).toHaveLength(2)
  expect(
    [...container.querySelectorAll('table')].map((table) => table.querySelectorAll('td').length)
  ).toEqual([5, 7])
  expect(container.textContent).not.toContain('No reliable caption association.')
  expect(container.textContent?.match(/Shared note/g)).toHaveLength(1)
  const section = container.querySelector('section[aria-label="B. Dewa data"]')!
  await act(async () => section.querySelector<HTMLInputElement>('input')!.click())
  await act(async () =>
    [...section.querySelectorAll('button')]
      .find((button) => button.textContent === 'Copy TSV')!
      .click()
  )
  expect(clipboard).toHaveBeenLastCalledWith('B0\tB1\tB2\tB3\tB4\tB5\tB6')
  expect(
    container.querySelector<HTMLInputElement>('section[aria-label="A. Tricco data"] input')!.checked
  ).toBe(false)
  await click('Image')
  expect(container.querySelectorAll('[data-pdf-image-frame]')).toHaveLength(1)
  expect(api.pdfStructure.readThumbnail).toHaveBeenLastCalledWith(
    expect.objectContaining({ thumbnailId: 'table-1' })
  )
  await click('Table')
  expect(container.querySelectorAll('table')).toHaveLength(2)
  expect(
    container.querySelector<HTMLInputElement>('section[aria-label="B. Dewa data"] input')!.checked
  ).toBe(true)
  await act(async () => render('reopened'))
  expect(container.querySelectorAll('table')).toHaveLength(2)
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('renders a small P-value marker as superscript while allele stars stay full size', async () => {
  const element = result.elements[0]
  api.pdfStructure.readCached.mockResolvedValue({
    ...result,
    elements: [
      {
        ...element,
        table: {
          ...element.table!,
          cells: [
            {
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 2,
              regions: [],
              text: 'DPB1*01:01 <0.01*',
              textRuns: [
                { text: 'DPB1*01:01 <0.01', position: 'normal' },
                { text: '*', position: 'superscript' }
              ]
            }
          ]
        }
      }
    ]
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  const cell = container.querySelector('td')!
  expect(cell.textContent).toBe('DPB1*01:01 <0.01*')
  expect(cell.querySelectorAll('sup')).toHaveLength(1)
  expect(cell.querySelector('sup')?.textContent).toBe('*')
})

it('shows partial cached results without automatically parsing the missing page', async () => {
  api.pdfStructure.readCached.mockResolvedValueOnce(result).mockResolvedValueOnce(undefined)
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={2} onNavigate={navigate} />
    )
  )
  expect(container.textContent).toContain('Merged header')
  expect(container.textContent).not.toContain('Analysis complete')
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(2)
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('keeps the loading state until cache lookup finishes, then offers analysis on a miss', async () => {
  let finish!: (value: undefined) => void
  api.pdfStructure.readCached.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  expect(container.textContent).not.toContain('Analyze PDF')
  await act(async () => finish(undefined))
  expect(container.textContent).toContain('Analyze PDF')
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('ignores a late cache restore from before the tab was hidden', async () => {
  let finish!: (value: PdfStructureResult) => void
  api.pdfStructure.readCached
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ ...result, elements: [] })
  const render = (active: boolean): void =>
    root.render(
      <PdfFiguresView
        active={active}
        attachmentVersionId="version-1"
        pageCount={1}
        onNavigate={navigate}
      />
    )
  await act(async () => render(true))
  await act(async () => render(false))
  await act(async () => render(true))
  expect(container.textContent).toContain('Analysis complete')
  await act(async () => finish(result))
  expect(container.textContent).not.toContain('Merged header')
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(2)
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('bounds cache read concurrency and preserves page order after out-of-order replies', async () => {
  const finish: Array<(value: PdfStructureResult) => void> = []
  for (let page = 1; page <= 4; page++) {
    api.pdfStructure.readCached.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish.push(resolve)
        })
    )
  }
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={5} onNavigate={navigate} />
    )
  )
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(4)
  await act(async () => {
    for (let index = 3; index >= 0; index--)
      finish[index]({
        ...result,
        extractionId: `page-${index}`,
        elements: [
          {
            ...result.elements[0],
            caption: { ...result.elements[0].caption!, text: `Table ${index + 1}.` }
          }
        ]
      })
  })
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(5)
  const labels = [...container.querySelectorAll('nav button')].map((button) => button.textContent)
  expect(labels.map((text) => text?.match(/Table \d\./)?.[0])).toEqual([
    'Table 1.',
    'Table 2.',
    'Table 3.',
    'Table 4.'
  ])
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
})

it('stops model polling while the figures tab is hidden', async () => {
  vi.useFakeTimers()
  const render = (active: boolean): void =>
    root.render(
      <PdfFiguresView
        active={active}
        attachmentVersionId="version-1"
        pageCount={1}
        onNavigate={navigate}
      />
    )
  await act(async () => render(true))
  const reads = api.localModels.getSnapshot.mock.calls.length
  await act(async () => render(false))
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(api.localModels.getSnapshot).toHaveBeenCalledTimes(reads)
  await act(async () => render(true))
  expect(api.localModels.getSnapshot).toHaveBeenCalledTimes(reads + 1)
})

it('shows the first cached figures before the remaining pages finish and stops work on hide', async () => {
  let finish!: (value: undefined) => void
  api.pdfStructure.readCached
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  const render = (active: boolean): void =>
    root.render(
      <PdfFiguresView
        active={active}
        attachmentVersionId="version-1"
        pageCount={12}
        onNavigate={navigate}
      />
    )
  await act(async () => render(true))
  expect(container.textContent).toContain('Merged header')
  expect(container.textContent).not.toContain('Analysis complete')
  expect(
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Analyze again'
    )?.disabled
  ).toBe(true)
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(8)
  await act(async () => render(false))
  await act(async () => finish(undefined))
  expect(api.pdfStructure.readCached).toHaveBeenCalledTimes(8)
  expect(container.textContent).toContain('Merged header')
})

it('does not overlap slow model snapshot requests', async () => {
  vi.useFakeTimers()
  api.localModels.getSnapshot.mockImplementationOnce(() => new Promise(() => {}))
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(api.localModels.getSnapshot).toHaveBeenCalledOnce()
})

it('does not commit table rerenders for unchanged model snapshots', async () => {
  vi.useFakeTimers()
  const render = vi.fn()
  api.localModels.getSnapshot.mockImplementation(async () => ({ ...model }))
  api.pdfStructure.readCached.mockResolvedValue(result)
  await act(async () =>
    root.render(
      <Profiler id="figures" onRender={render}>
        <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
      </Profiler>
    )
  )
  render.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(api.localModels.getSnapshot).toHaveBeenCalledTimes(4)
  expect(render).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Merged header')
})

it('loads table images only when their image tab is opened', async () => {
  api.pdfStructure.readCached.mockResolvedValue(result)
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  expect(api.pdfStructure.readThumbnail).not.toHaveBeenCalled()
  await click('Image')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledOnce()
  await click('Table')
  await click('Image')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledOnce()
})

it('shows algorithms as original images with titles and source navigation', async () => {
  api.pdfStructure.readCached.mockResolvedValue({
    ...result,
    elements: [
      {
        ...result.elements[0],
        kind: 'algorithm',
        table: undefined,
        caption: { text: 'Algorithm 1 Search', regions: result.elements[0].regions }
      }
    ]
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  expect(container.querySelector('[data-pdf-caption]')?.textContent).toBe('Algorithm 1 Search')
  expect(container.querySelector('table')).toBeNull()
  expect(container.textContent).not.toContain('Copy TSV')
  expect(container.textContent).not.toContain('Unplaced table text')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledOnce()
  await click('Show in PDF')
  expect(navigate).toHaveBeenCalledWith(1)
})

it('switches focused index entries with Up/Down without stealing detail or modified keys', async () => {
  await showFigures(2)
  const buttons = container.querySelectorAll<HTMLButtonElement>('nav button')
  const press = async (target: Element, key: string, shiftKey = false): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    await act(async () => target.dispatchEvent(event))
    return event
  }
  buttons[0].focus()
  expect((await press(buttons[0], 'ArrowDown')).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(buttons[1])
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  await press(buttons[1], 'ArrowDown')
  expect(document.activeElement).toBe(buttons[1])
  expect((await press(buttons[1], 'ArrowUp', true)).defaultPrevented).toBe(false)
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  expect(
    (await press(container.querySelector('[data-pdf-figure-detail]')!, 'ArrowUp')).defaultPrevented
  ).toBe(false)
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  await press(buttons[1], 'ArrowUp')
  expect(document.activeElement).toBe(buttons[0])
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
})

it('reserves the same image geometry through URL loading, decoding and retry', async () => {
  let resolveImage!: (value: string) => void
  api.pdfStructure.readThumbnail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveImage = resolve
      })
  )
  await showFigures()
  const frame = container.querySelector<HTMLElement>('[data-pdf-image-frame]')!
  const style = frame.getAttribute('style')
  expect(frame.style.aspectRatio).toBe('2 / 1')
  expect(frame.getAttribute('aria-busy')).toBe('true')
  expect(container.querySelector('[data-pdf-caption]')?.textContent).toBe('Figure 1. Caption.')
  await act(async () => resolveImage('data:image/png;base64,eA=='))
  expect(frame.getAttribute('aria-busy')).toBe('true')
  await act(async () => frame.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(frame.getAttribute('aria-busy')).toBe('false')
  expect(frame.textContent).toContain('Reload image')
  expect(container.textContent).not.toContain('Preview unavailable.')
  await click('Reload image')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledTimes(2)
  expect(frame.getAttribute('aria-busy')).toBe('true')
  await act(async () => frame.querySelector('img')!.dispatchEvent(new Event('load')))
  expect(frame.getAttribute('aria-busy')).toBe('false')
  expect(frame.querySelector('[role="status"]')).toBeNull()
  expect(frame.getAttribute('style')).toBe(style)
})

it('keeps navigation bounded and ignores a previous selection’s late image', async () => {
  let resolveImage!: (value: string) => void
  api.pdfStructure.readThumbnail
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveImage = resolve
        })
    )
    .mockResolvedValueOnce('data:image/png;base64,c2Vjb25k')
  await showFigures(2)
  const previous = container.querySelector<HTMLButtonElement>(
    '[aria-label="Previous figure or table"]'
  )!
  const next = container.querySelector<HTMLButtonElement>('[aria-label="Next figure or table"]')!
  expect(previous.disabled).toBe(true)
  expect(next.disabled).toBe(false)
  await act(async () => next.click())
  expect(next.disabled).toBe(true)
  expect(previous.disabled).toBe(false)
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Figure 2')
  expect(container.querySelector('[data-pdf-caption]')?.textContent).toBe('Figure 2. Caption.')
  await act(async () => resolveImage('data:image/png;base64,c3RhbGU='))
  expect(container.querySelector('[data-pdf-image-frame] img')?.getAttribute('src')).toBe(
    'data:image/png;base64,c2Vjb25k'
  )
  await act(async () => previous.click())
  expect(container.querySelector('[data-pdf-caption]')?.textContent).toBe('Figure 1. Caption.')
})

it.each(['rejected', 'absent'])('offers retry when the cached image is %s', async (failure) => {
  if (failure === 'rejected')
    api.pdfStructure.readThumbnail.mockRejectedValueOnce(new Error('missing cache'))
  else api.pdfStructure.readThumbnail.mockResolvedValueOnce(undefined)
  await showFigures()
  expect(container.querySelector('[data-pdf-image-frame]')?.getAttribute('aria-busy')).toBe('false')
  await click('Reload image')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledTimes(2)
})

it('preserves source figure numbers when earlier figures were not extracted', async () => {
  await showFigures(1, 3)
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Figure 3.')
  expect(container.querySelector('[role="combobox"]')?.textContent).not.toContain('Figure 1')
})

it('shows previously loaded figures immediately without another thumbnail read', async () => {
  await showFigures(2)
  await act(async () =>
    container.querySelector('[data-pdf-image-frame] img')!.dispatchEvent(new Event('load'))
  )
  const previous = container.querySelector<HTMLButtonElement>(
    '[aria-label="Previous figure or table"]'
  )!
  const next = container.querySelector<HTMLButtonElement>('[aria-label="Next figure or table"]')!
  await act(async () => next.click())
  await act(async () => previous.click())
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-pdf-image-frame]')?.getAttribute('aria-busy')).toBe('false')
  expect(container.querySelector('[aria-label="Enlarge image"]')).not.toBeNull()
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Figure 1. Caption.')
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Page 1')
  await click('Analyze again')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledTimes(3)
  expect(container.querySelector('[data-pdf-image-frame]')?.getAttribute('aria-busy')).toBe('true')
})

it('copies the source PNG and downloads the same bytes from the enlarged preview', async () => {
  class Item {
    constructor(readonly data: Record<string, Blob>) {}
  }
  const bytes = new Uint8Array([120]).buffer
  const fetchImage = vi.fn().mockRejectedValue(new Error('Blocked by CSP'))
  vi.stubGlobal('fetch', fetchImage)
  vi.stubGlobal('ClipboardItem', Item)
  const write = vi.fn<(items: Item[]) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
  await showFigures()
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Enlarge image"]')!.click()
  )
  const dialog = document.body.querySelector('[role="dialog"]')!
  const copy = dialog.querySelector<HTMLButtonElement>('[aria-label="Copy image"]')!
  const download = dialog.querySelector<HTMLButtonElement>('[aria-label="Download image"]')!
  expect(copy).not.toBeNull()
  expect(download).not.toBeNull()
  await act(async () => copy.click())
  expect(fetchImage).not.toHaveBeenCalled()
  const png = write.mock.calls[0][0][0].data['image/png']
  expect(png.type).toBe('image/png')
  const copiedBytes = await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsArrayBuffer(png)
  })
  expect(copiedBytes).toEqual(bytes)
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe('Copied')
  await act(async () => download.click())
  expect(api.saveBlobFile).toHaveBeenCalledWith({
    suggestedName: 'pdf-figure-0-page-1.png',
    mimeType: 'image/png',
    data: bytes
  })
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe('Saved')
  api.saveBlobFile.mockResolvedValueOnce({ saved: false })
  await act(async () => download.click())
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe('')
  write.mockRejectedValueOnce(new Error('Permission denied'))
  await act(async () => copy.click())
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
    'Could not copy the image. Try again.'
  )
  expect(copy.disabled).toBe(false)
  api.saveBlobFile.mockRejectedValueOnce(new Error('Disk full'))
  await act(async () => download.click())
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe(
    'Could not save the image. Try again.'
  )
  expect(download.disabled).toBe(false)
})

it('offers original-page navigation without an endless skeleton when no crop exists', async () => {
  api.pdfStructure.parse.mockResolvedValue({
    ...result,
    elements: [{ ...result.elements[0], kind: 'figure', table: undefined, thumbnailId: undefined }]
  })
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version-1" pageCount={1} onNavigate={navigate} />
    )
  )
  await click('Analyze PDF')
  const frame = container.querySelector('[data-pdf-image-frame]')!
  expect(frame.getAttribute('aria-busy')).toBe('false')
  expect(frame.querySelector('[role="status"]')).toBeNull()
  expect(api.pdfStructure.readThumbnail).not.toHaveBeenCalled()
  await act(async () => frame.querySelector('button')!.click())
  expect(navigate).toHaveBeenCalledWith(1)
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
  expect(container.querySelector('table')?.closest('[hidden]')).not.toBeNull()
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
          notes: [{ text: '* Original note.²³', regions: result.elements[0].regions }]
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
  expect(container.textContent).toContain('* Original note.²³')
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
  expect(await readBlob(item.data['text/html'])).toContain('<p>* Original note.²³</p>')
  expect(await readBlob(item.data['text/plain'])).toContain(
    'Merged header\t\nValue\t[Missing]\n\n* Original note.²³'
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
  expect(container.querySelector('article > [hidden]')?.textContent).toContain(
    'Unplaced table text'
  )
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
  expect(container.querySelector('header')?.textContent).toContain('Analysis complete')
  expect(container.querySelector('header p')?.getAttribute('title')).toBe('Processed 2 / 2 pages')
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

it('renders and copies one continued table while retaining the next page image and navigation', async () => {
  const batches: PdfStructureResult[] = [4, 5].map((page) => {
    const region = { page, x: 0.1, y: 0.1, width: 0.8, height: 0.5 }
    return {
      ...result,
      extractionId: `result-${page}`,
      requestedPages: [page],
      processedPages: [page],
      elements: [
        {
          ...result.elements[0],
          id: `table-${page}`,
          thumbnailId: `table-${page}`,
          regions: [region],
          caption: {
            text: page === 4 ? 'Table 1. Baseline data.' : 'Table 1. (continued)',
            regions: [region]
          },
          table: {
            rowCount: 2,
            columnCount: 2,
            issues: [],
            unassignedText: [],
            cells: [
              ['Variable', 'Count'],
              [page === 4 ? 'Letrozole' : 'Anastrozole', page === 4 ? '11' : '3']
            ].flatMap((row, r) =>
              row.map((text, column) => ({
                row: r,
                column,
                rowSpan: 1,
                columnSpan: 1,
                text,
                regions: [region]
              }))
            ),
            notes: page === 4 ? [] : [{ text: 'Shared table note.', regions: [region] }]
          }
        }
      ]
    }
  })
  let finish!: (value: PdfStructureResult) => void
  api.pdfStructure.readCached
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(batches[0])
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  await act(async () =>
    root.render(
      <PdfFiguresView attachmentVersionId="version" pageCount={5} onNavigate={navigate} />
    )
  )
  const originalReview = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => originalReview.click())
  expect(originalReview.checked).toBe(true)
  await act(async () => finish(batches[1]))
  expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
    false
  )
  expect(container.textContent).toContain('Pages 4–5')
  expect(container.querySelectorAll('table')).toHaveLength(1)
  expect([...container.querySelectorAll('table tr')].map((r) => r.textContent)).toEqual([
    'VariableCount',
    'Letrozole11',
    'Anastrozole3'
  ])
  expect(container.querySelectorAll('[data-pdf-caption]')).toHaveLength(1)
  expect(container.textContent).toContain('Shared table note.')
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => checkbox.click())
  await click('Copy TSV')
  expect(clipboard).toHaveBeenLastCalledWith('Variable\tCount\nLetrozole\t11\nAnastrozole\t3')
  expect(api.pdfStructure.readThumbnail).toHaveBeenCalledWith(
    expect.objectContaining({ page: 5, extractionId: 'result-5', thumbnailId: 'table-5' })
  )
  const nextPage = [...container.querySelectorAll('article')].find((a) =>
    a.textContent?.includes('Page 5')
  )!
  const open = [...nextPage.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Show in PDF')
  )!
  await act(async () => open.click())
  expect(navigate).toHaveBeenLastCalledWith(5)
})
