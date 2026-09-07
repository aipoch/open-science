// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { utils, write } from 'styled-exceljs'
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate'
import { renderAsync } from 'docx-preview'
import {
  createSpreadsheetParserContext,
  handleSpreadsheetWorkerRequest
} from '@file-viewer/renderer-spreadsheet/worker/sheetjs'
import { initI18n } from '../../../i18n'
import { runOfficePreview } from '../../../office-preview/office-preview-runtime'
import { validateOfficePackage } from './office-package'
import { renderOfficeFile } from './office-renderers'

vi.mock('@file-viewer/renderer-spreadsheet/worker/sheetjs/sheet.worker?worker&url', () => ({
  default: 'local-sheet-worker.js'
}))

// Execute the installed parser using its real Worker protocol; only thread transport is simulated.
class ParserWorker extends EventTarget {
  static instances: ParserWorker[] = []
  context = createSpreadsheetParserContext()
  terminated = false
  responses: unknown[] = []
  constructor() {
    super()
    ParserWorker.instances.push(this)
  }
  postMessage(message: Parameters<typeof handleSpreadsheetWorkerRequest>[1]): void {
    window.setTimeout(() => {
      void Promise.resolve(handleSpreadsheetWorkerRequest(this.context, message)).then(
        (responses) => {
          if (this.terminated) return
          this.responses.push(...responses)
          for (const data of responses) this.dispatchEvent(new MessageEvent('message', { data }))
        }
      )
    }, 0)
  }
  terminate(): void {
    this.terminated = true
  }
}

const workbookBytes = (
  extension: 'xlsx' | 'xls',
  visibleData = false,
  hidden = false
): Uint8Array => {
  const workbook = utils.book_new()
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet(visibleData ? [['VISIBLE_DATA']] : []),
    'Visible'
  )
  if (hidden) {
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['HIDDEN_DATA']]), 'Hidden')
    utils.book_set_sheet_visibility(workbook, 'Hidden', 1)
  }
  return new Uint8Array(write(workbook, { type: 'array', bookType: extension }))
}

const bookmarkDocx = (): Uint8Array =>
  zipSync(
    {
      '[Content_Types].xml': strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      ),
      '_rels/.rels': strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      ),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:hyperlink w:anchor="section1"><w:r><w:t>Jump to section</w:t></w:r></w:hyperlink></w:p><w:p><w:bookmarkStart w:id="1" w:name="section1"/><w:r><w:t>Section one</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:sectPr/></w:body></w:document>'
      )
    },
    { level: 0 }
  )

describe('Office behavior through real parsers and adapters', () => {
  let container: HTMLDivElement
  let controller: AbortController
  let cleanup: (() => void | Promise<void>) | undefined
  const harness = { instances: [] as Array<{ getRows: () => Array<Record<string, unknown>> }> }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    controller = new AbortController()
    cleanup = undefined
    harness.instances = []
    ParserWorker.instances = []
    vi.stubGlobal('Worker', ParserWorker)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.stubGlobal('__openScienceTestTableHarness', harness)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
  })
  afterEach(async () => {
    controller.abort()
    await cleanup?.()
    ParserWorker.instances.forEach((worker) => worker.terminate())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const renderWorkbook = async (
    bytes: Uint8Array,
    extension: 'xlsx' | 'xls'
  ): Promise<{ state: 'pending' | 'ready' | 'error' }> => {
    await validateOfficePackage(bytes, extension, controller.signal)
    const outcome = { state: 'pending' as 'pending' | 'ready' | 'error' }
    const completion = renderOfficeFile({
      bytes,
      extension,
      name: `book.${extension}`,
      container,
      signal: controller.signal
    })
      .then((dispose) => {
        cleanup = dispose
        outcome.state = 'ready'
      })
      .catch(() => {
        outcome.state = 'error'
      })
    // Always release a pending first-paint wait, including when an assertion fails.
    cleanup = async () => {
      controller.abort()
      await completion
    }
    await vi.waitFor(() =>
      expect(ParserWorker.instances[0]?.responses).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'sheets' })])
      )
    )
    return outcome
  }

  it.each(['xlsx', 'xls'] as const)(
    'OF01: a blank visible %s sheet completes first paint',
    async (extension) => {
      const outcome = await renderWorkbook(workbookBytes(extension), extension)
      await vi.waitFor(() => expect(outcome.state).toBe('ready'), { timeout: 2_000 })
      expect(
        Array.from(container.querySelectorAll('.sheet-tab'), (tab) => tab.textContent)
      ).toEqual(['Visible'])
    }
  )

  it.each([
    ['xlsx', false],
    ['xlsx', true],
    ['xls', false]
  ] as const)(
    'OF02: %s visible data=%s never selects hidden content',
    async (extension, visibleData) => {
      const outcome = await renderWorkbook(workbookBytes(extension, visibleData, true), extension)
      await vi.waitFor(() => expect(outcome.state).toBe('ready'))
      expect(JSON.stringify(harness.instances.flatMap((table) => table.getRows()))).not.toContain(
        'HIDDEN_DATA'
      )
      expect(
        Array.from(container.querySelectorAll('.sheet-tab'), (tab) => tab.textContent)
      ).toEqual(['Visible'])
    }
  )

  it('waits for the first visible sheet window before completing first paint', async () => {
    const postMessage = ParserWorker.prototype.postMessage
    let releaseWindow: (() => void) | undefined
    vi.spyOn(ParserWorker.prototype, 'postMessage').mockImplementation(function (
      this: ParserWorker,
      message
    ) {
      if (message.type === 'parseSheet') {
        releaseWindow = () => postMessage.call(this, message)
      } else {
        postMessage.call(this, message)
      }
    })
    const outcome = await renderWorkbook(workbookBytes('xlsx', true), 'xlsx')
    await vi.waitFor(() => expect(releaseWindow).toBeDefined())
    // Let any readiness callbacks from the sheets event settle while the data window is held.
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(outcome.state).toBe('pending')
    expect(container.querySelector('.spreadsheet-empty')).toBeNull()
    expect(getComputedStyle(container.querySelector<HTMLElement>('.toolbar')!).display).not.toBe(
      'none'
    )
    releaseWindow!()
    await vi.waitFor(() => expect(outcome.state).toBe('ready'))
    expect(JSON.stringify(harness.instances.flatMap((table) => table.getRows()))).toContain(
      'VISIBLE_DATA'
    )
  })

  it('keeps visible worksheet tabs displayed and switches to another worksheet', async () => {
    const workbook = utils.book_new()
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['FIRST_DATA']]), 'First')
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([['SECOND_DATA']]), 'Second')
    const outcome = await renderWorkbook(
      new Uint8Array(write(workbook, { type: 'array', bookType: 'xlsx' })),
      'xlsx'
    )
    await vi.waitFor(() => expect(outcome.state).toBe('ready'))
    const toolbar = container.querySelector<HTMLElement>('.toolbar')!
    expect(getComputedStyle(toolbar).display).not.toBe('none')
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.sheet-tab'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['First', 'Second'])
    tabs[1].click()
    await vi.waitFor(() =>
      expect(JSON.stringify(harness.instances.flatMap((table) => table.getRows()))).toContain(
        'SECOND_DATA'
      )
    )
    expect(getComputedStyle(toolbar).display).not.toBe('none')
  })

  it.each([1, 2] as const)(
    'completes an all-hidden workbook without exposing Hidden=%s',
    async (hidden) => {
      const workbook = utils.book_new()
      utils.book_append_sheet(workbook, utils.aoa_to_sheet([['HIDDEN_DATA']]), 'Private')
      utils.book_set_sheet_visibility(workbook, 'Private', hidden)
      const bytes = new Uint8Array(write(workbook, { type: 'array', bookType: 'xlsx' }))
      const outcome = await renderWorkbook(bytes, 'xlsx')
      await vi.waitFor(() => expect(outcome.state).toBe('ready'))
      expect(container.querySelectorAll('.sheet-tab')).toHaveLength(0)
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        'This workbook has no visible worksheets.'
      )
      expect(JSON.stringify(harness.instances.flatMap((table) => table.getRows()))).not.toContain(
        'HIDDEN_DATA'
      )
    }
  )

  it('completes a successfully parsed package with zero worksheets', async () => {
    const entries = unzipSync(workbookBytes('xlsx'))
    entries['xl/workbook.xml'] = strToU8(
      strFromU8(entries['xl/workbook.xml']).replace(/<sheets>.*?<\/sheets>/s, '<sheets/>')
    )
    const outcome = await renderWorkbook(zipSync(entries, { level: 0 }), 'xlsx')
    await vi.waitFor(() => expect(outcome.state).toBe('ready'))
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'This workbook has no worksheets.'
    )
    expect(container.querySelectorAll('.sheet-tab')).toHaveLength(0)
  })

  it('preserves original sheet identity and hidden flags across blank sheets', async () => {
    await renderWorkbook(workbookBytes('xlsx', false, true), 'xlsx')
    const context = ParserWorker.instances[0].context
    expect(context.workbook?.SheetNames).toEqual(['Visible', 'Hidden'])
    expect(context.sheets).toEqual([
      expect.objectContaining({ id: 0, name: 'Visible', hidden: false }),
      expect.objectContaining({ id: 1, name: 'Hidden', hidden: true })
    ])
    expect(context.workbook?.Workbook?.Sheets?.map((sheet) => sheet.Hidden)).toEqual([0, 1])
  })

  it.each([
    ['zh-Hans', '此工作簿没有可见的工作表。'],
    [undefined, 'This workbook has no visible worksheets.']
  ] as const)(
    'applies startup locale %s before rendering the empty state',
    async (locale, expected) => {
      initI18n(locale ? 'en' : 'de')
      const workbook = utils.book_new()
      utils.book_append_sheet(workbook, utils.aoa_to_sheet([]), 'Private')
      utils.book_set_sheet_visibility(workbook, 'Private', 1)
      const bytes = new Uint8Array(write(workbook, { type: 'array', bookType: 'xlsx' }))
      const start = {
        sessionId: 'locale-session',
        extension: 'xlsx' as const,
        name: 'hidden.xlsx',
        attempt: 0,
        locale,
        resource: {
          id: 'locale-resource',
          url: 'https://preview.test/hidden.xlsx',
          size: bytes.byteLength,
          mimeType: 'application/octet-stream',
          version: 1
        }
      }
      try {
        cleanup = await runOfficePreview({
          start,
          container,
          fetchFile: vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes).buffer)),
          reportState: vi.fn()
        })
        expect(container.querySelector('[role="status"]')?.textContent).toBe(expected)
      } finally {
        initI18n('en')
      }
    }
  )

  it('OF03: reports a terminal Worker failure after ready', async () => {
    const bytes = workbookBytes('xlsx', true)
    const reportState = vi.fn()
    cleanup = await runOfficePreview({
      start: {
        sessionId: 'session-1',
        extension: 'xlsx',
        name: 'book.xlsx',
        attempt: 0,
        resource: {
          id: 'resource-1',
          url: 'https://preview.test/book.xlsx',
          size: bytes.byteLength,
          mimeType: 'application/octet-stream',
          version: 1
        }
      },
      container,
      fetchFile: vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes).buffer)),
      reportState
    })
    expect(reportState).toHaveBeenLastCalledWith({ sessionId: 'session-1', phase: 'ready' })
    ParserWorker.instances[0].dispatchEvent(
      new ErrorEvent('error', { message: 'Worker cannot continue' })
    )
    await vi.waitFor(() =>
      expect(reportState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          phase: 'error',
          error: 'RENDER_FAILED'
        })
      )
    )
    await vi.waitFor(() => expect(ParserWorker.instances[0].terminated).toBe(true))
    expect(container.childNodes).toHaveLength(0)
    const reports = reportState.mock.calls.length
    ParserWorker.instances[0].dispatchEvent(
      new ErrorEvent('error', { message: 'duplicate failure' })
    )
    await cleanup?.()
    expect(reportState).toHaveBeenCalledTimes(reports)
  })

  it('never resolves a DOCX bookmark outside its own preview', async () => {
    const entries = unzipSync(bookmarkDocx())
    entries['word/document.xml'] = strToU8(
      strFromU8(entries['word/document.xml']).replace('w:anchor="section1"', 'w:anchor="outside"')
    )
    const outside = document.createElement('div')
    outside.id = 'outside'
    document.body.append(outside)
    try {
      cleanup = await renderOfficeFile({
        bytes: zipSync(entries, { level: 0 }),
        extension: 'docx',
        name: 'outside.docx',
        container,
        signal: controller.signal
      })
      const scroll = vi.spyOn(outside, 'scrollIntoView')
      container.querySelector<HTMLAnchorElement>('a')!.click()
      expect(scroll).not.toHaveBeenCalled()
      expect(container.querySelector('a')?.getAttribute('href')).toBeNull()
    } finally {
      outside.remove()
    }
  })

  it('OF04: activates a real DOCX bookmark inside the preview', async () => {
    const bytes = bookmarkDocx()
    await validateOfficePackage(bytes, 'docx', controller.signal)
    const direct = document.createElement('div')
    await renderAsync(bytes, direct, direct, { useBase64URL: true })
    expect(direct.querySelector('a')?.getAttribute('href')).toBe('#section1')
    cleanup = await renderOfficeFile({
      bytes,
      extension: 'docx',
      name: 'bookmarks.docx',
      container,
      signal: controller.signal
    })
    const target = container.querySelector<HTMLElement>('[id="section1"]')!
    expect(target).not.toBeNull()
    const scroll = vi.spyOn(target, 'scrollIntoView')
    container.querySelector<HTMLAnchorElement>('a')!.click()
    expect(scroll).toHaveBeenCalledOnce()
    const link = container.querySelector<HTMLAnchorElement>('a')!
    expect(link.getAttribute('href')).toBeNull()
    expect(link.tabIndex).toBe(0)
    link.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    expect(scroll).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(target)
    expect(target.getAttribute('tabindex')).toBe('-1')
    await cleanup?.()
    expect(target.hasAttribute('tabindex')).toBe(false)
    link.click()
    expect(scroll).toHaveBeenCalledTimes(2)
  })
})
