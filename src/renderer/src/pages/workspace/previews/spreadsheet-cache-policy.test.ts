// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tableHarness = {
  instances: [] as Array<{
    ctx: { body: { headIndex: number; tailIndex: number }; scrollY: number }
    emit: (event: string) => void
    getRows: () => Array<Record<string, unknown>>
  }>
}

type WorkerMessage = {
  type: string
  payload?: {
    sessionId?: number
    sheet?: number
    startRow?: number
  }
}

const disposeSpreadsheet = async (
  instance: Awaited<
    ReturnType<(typeof import('@file-viewer/renderer-spreadsheet'))['renderFileViewerSpreadsheet']>
  >
): Promise<void> => {
  if ('unmount' in instance) await instance.unmount()
  else if ('$destroy' in instance) await instance.$destroy()
  else await instance.destroy()
}

class SpreadsheetWorker extends EventTarget {
  static parseStarts: number[] = []
  static parseRequests: Array<{ sheet: number; startRow: number }> = []
  static sheets = [{ id: 0, name: 'Data', hidden: false, rowCount: 10_000, colCount: 2 }]
  static responseDelayMs = 0
  static pendingRequests = 0
  static maxPendingRequests = 0

  postMessage(message: WorkerMessage): void {
    if (message.type === 'parseWorkbook') {
      window.setTimeout(() => {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'sheets',
              payload: {
                sheets: SpreadsheetWorker.sheets
              }
            }
          })
        )
      })
      return
    }

    if (message.type !== 'parseSheet' || !message.payload) return
    const { sessionId = 0, sheet = 0, startRow = 0 } = message.payload
    SpreadsheetWorker.parseStarts.push(startRow)
    SpreadsheetWorker.parseRequests.push({ sheet, startRow })
    SpreadsheetWorker.pendingRequests += 1
    SpreadsheetWorker.maxPendingRequests = Math.max(
      SpreadsheetWorker.maxPendingRequests,
      SpreadsheetWorker.pendingRequests
    )
    const endRow = Math.min(startRow + 500, 10_000)
    window.setTimeout(() => {
      SpreadsheetWorker.pendingRequests -= 1
      this.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'parseSheet',
            payload: {
              sessionId,
              sheet,
              sheetData: {
                defaults: { rowHeight: 20, colWidth: 64 },
                data: Array.from({ length: endRow - startRow }, (_, index) => [
                  `sheet-${sheet}-row-${startRow + index}`,
                  startRow + index
                ]),
                cell: {},
                merge: [],
                rowHeights: 20,
                colWidths: 64,
                columns: [
                  { key: 1, title: 'A', editor: false },
                  { key: 2, title: 'B', editor: false }
                ],
                meta: {
                  startRow,
                  endRow,
                  pageSize: 500,
                  totalRows: 10_000,
                  totalCols: 2
                },
                ...(startRow === 0
                  ? {
                      structure: {
                        merge: [],
                        colWidths: 64,
                        rowHeights: 20,
                        columns: [
                          { key: 1, title: 'A', editor: false },
                          { key: 2, title: 'B', editor: false }
                        ],
                        images: [],
                        charts: []
                      }
                    }
                  : {})
              }
            }
          }
        })
      )
    }, SpreadsheetWorker.responseDelayMs)
  }

  terminate(): void {
    // No background process is created by this deterministic test Worker.
  }
}

describe('patched spreadsheet window cache', () => {
  beforeEach(() => {
    tableHarness.instances = []
    SpreadsheetWorker.parseStarts = []
    SpreadsheetWorker.parseRequests = []
    SpreadsheetWorker.sheets = [
      { id: 0, name: 'Data', hidden: false, rowCount: 10_000, colCount: 2 }
    ]
    SpreadsheetWorker.responseDelayMs = 0
    SpreadsheetWorker.pendingRequests = 0
    SpreadsheetWorker.maxPendingRequests = 0
    vi.stubGlobal('__openScienceTestTableHarness', tableHarness)
    vi.stubGlobal('Worker', SpreadsheetWorker)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    const frameTimers = new Map<number, number>()
    let nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const frame = nextFrame++
      frameTimers.set(
        frame,
        window.setTimeout(() => {
          frameTimers.delete(frame)
          callback(0)
        })
      )
      return frame
    })
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
      const timer = frameTimers.get(frame)
      if (timer !== undefined) window.clearTimeout(timer)
      frameTimers.delete(frame)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('keeps at most six 500-row windows and reloads an evicted window', async () => {
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet')
    const target = document.createElement('div')
    document.body.appendChild(target)

    const instance = await renderFileViewerSpreadsheet(new ArrayBuffer(8), target, 'xlsx', {
      options: {
        locale: 'en-US',
        spreadsheet: { worker: true, workerUrl: 'sheet-worker.js' }
      }
    })
    await vi.waitFor(() => {
      expect(SpreadsheetWorker.parseStarts).toContain(1_500)
      expect(target.querySelector('.sheet-loading')?.classList.contains('hidden')).toBe(true)
    })

    const table = tableHarness.instances[0]
    table.ctx.body.headIndex = 4_000
    table.ctx.body.tailIndex = 4_020
    table.ctx.scrollY = 80_000
    table.emit('onScrollY')

    await vi.waitFor(() => {
      expect(SpreadsheetWorker.parseStarts).toContain(5_500)
      expect(target.querySelector('.sheet-loading-summary')?.textContent).toContain('3,000')
      expect(target.querySelector('.sheet-loading')?.classList.contains('hidden')).toBe(true)
    })
    const firstRow = table.getRows()[0]
    expect(firstRow?.__baseHeight).toBeUndefined()
    expect(firstRow?._height).toBeUndefined()

    table.ctx.body.headIndex = 0
    table.ctx.body.tailIndex = 20
    table.ctx.scrollY = 0
    table.emit('onScrollY')
    await vi.waitFor(() => {
      expect(
        [0, 500, 1_000, 1_500].some(
          (start) => SpreadsheetWorker.parseStarts.filter((value) => value === start).length > 1
        )
      ).toBe(true)
    })

    await disposeSpreadsheet(instance)
  })

  it('limits pending viewport requests while rapid scrolling coalesces around the latest range', async () => {
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const instance = await renderFileViewerSpreadsheet(new ArrayBuffer(8), target, 'xlsx', {
      options: {
        locale: 'en-US',
        spreadsheet: { worker: true, workerUrl: 'sheet-worker.js' }
      }
    })
    await vi.waitFor(() => expect(SpreadsheetWorker.parseStarts).toContain(1_500))

    SpreadsheetWorker.responseDelayMs = 50
    const table = tableHarness.instances[0]
    for (const startRow of [2_000, 4_000, 6_000, 8_000]) {
      table.ctx.body.headIndex = startRow
      table.ctx.body.tailIndex = startRow + 20
      table.ctx.scrollY = startRow * 20
      table.emit('onScrollY')
      await new Promise((resolve) => window.setTimeout(resolve, 2))
    }

    expect(SpreadsheetWorker.maxPendingRequests).toBeLessThanOrEqual(6)
    await disposeSpreadsheet(instance)
  })

  it('retains only the current and most recently viewed worksheet', async () => {
    SpreadsheetWorker.sheets = ['First', 'Second', 'Third'].map((name, id) => ({
      id,
      name,
      hidden: false,
      rowCount: 10_000,
      colCount: 2
    }))
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet')
    const target = document.createElement('div')
    document.body.appendChild(target)

    const instance = await renderFileViewerSpreadsheet(new ArrayBuffer(8), target, 'xlsx', {
      options: {
        locale: 'en-US',
        spreadsheet: { worker: true, workerUrl: 'sheet-worker.js' }
      }
    })
    await vi.waitFor(() => {
      expect(SpreadsheetWorker.parseRequests).toContainEqual({ sheet: 0, startRow: 0 })
    })

    const clickTab = (name: string): void => {
      Array.from(target.querySelectorAll<HTMLButtonElement>('.sheet-tab'))
        .find((button) => button.textContent === name)
        ?.click()
    }
    const expectSheetReady = async (name: string): Promise<void> => {
      await vi.waitFor(() => {
        const active = target.querySelector<HTMLButtonElement>('.sheet-tab[aria-pressed="true"]')
        expect(active?.textContent).toBe(name)
        expect(target.querySelector('.loading')?.classList.contains('hidden')).toBe(true)
        expect(target.querySelector('.sheet-loading')?.classList.contains('hidden')).toBe(true)
      })
    }

    clickTab('Second')
    await vi.waitFor(() => {
      expect(SpreadsheetWorker.parseRequests).toContainEqual({ sheet: 1, startRow: 0 })
    })
    await expectSheetReady('Second')
    clickTab('Third')
    await vi.waitFor(() => {
      expect(SpreadsheetWorker.parseRequests).toContainEqual({ sheet: 2, startRow: 0 })
    })
    await expectSheetReady('Third')
    clickTab('First')
    await vi.waitFor(() => {
      expect(
        SpreadsheetWorker.parseRequests.filter(
          ({ sheet, startRow }) => sheet === 0 && startRow === 0
        )
      ).toHaveLength(2)
    })

    await disposeSpreadsheet(instance)
  })

  it('bounds Worker requests globally while rapidly switching worksheets', async () => {
    SpreadsheetWorker.sheets = Array.from({ length: 10 }, (_, id) => ({
      id,
      name: `Sheet ${id + 1}`,
      hidden: false,
      rowCount: 10_000,
      colCount: 2
    }))
    SpreadsheetWorker.responseDelayMs = 40
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet')
    const target = document.createElement('div')
    document.body.appendChild(target)
    const instance = await renderFileViewerSpreadsheet(new ArrayBuffer(8), target, 'xlsx', {
      options: {
        locale: 'en-US',
        spreadsheet: { worker: true, workerUrl: 'sheet-worker.js' }
      }
    })
    await vi.waitFor(() => expect(target.querySelectorAll('.sheet-tab')).toHaveLength(10))

    for (const button of target.querySelectorAll<HTMLButtonElement>('.sheet-tab')) button.click()

    await vi.waitFor(
      () => {
        const active = target.querySelector<HTMLButtonElement>('.sheet-tab[aria-pressed="true"]')
        expect(active?.textContent).toBe('Sheet 10')
        expect(SpreadsheetWorker.parseRequests).toContainEqual({ sheet: 9, startRow: 0 })
        expect(Object.values(tableHarness.instances[0]?.getRows()[0] ?? {})).toContain(
          'sheet-9-row-0'
        )
        expect(target.querySelector('.sheet-loading')?.classList.contains('hidden')).toBe(true)
      },
      { timeout: 2_000 }
    )
    expect(SpreadsheetWorker.maxPendingRequests).toBeLessThanOrEqual(6)

    await disposeSpreadsheet(instance)
  })
})
