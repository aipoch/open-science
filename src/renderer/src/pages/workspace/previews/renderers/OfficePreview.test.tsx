// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { PreviewFileContent } from '../PreviewFileContent'
import {
  LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS,
  OFFICE_PREVIEW_TIMEOUT_MS,
  OfficePreviewRenderer
} from './OfficePreview'

const mocks = vi.hoisted(() => ({
  readBytes: vi.fn(),
  isLegacyExcel: vi.fn(),
  validate: vi.fn(),
  render: vi.fn()
}))

vi.mock('../managed-file-bytes', () => ({ readManagedFileBytes: mocks.readBytes }))
vi.mock('../office-package', () => ({
  DOCX_PREVIEW_MAX_COMPRESSED_BYTES: 10 * 1024 * 1024,
  OFFICE_PREVIEW_MAX_COMPRESSED_BYTES: 50 * 1024 * 1024,
  isLegacyExcelFile: mocks.isLegacyExcel,
  validateOfficePackage: mocks.validate
}))
vi.mock('../office-renderers', () => ({ renderOfficeFile: mocks.render }))

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

const createItem = (overrides: Partial<PreviewFileItem> = {}): PreviewFileItem => ({
  id: 'office-1',
  sessionId: 'session-1',
  title: 'report.docx',
  type: 'file',
  source: 'artifact',
  path: '/artifacts/report.docx',
  name: 'report.docx',
  format: 'word',
  ...overrides
})

describe('OfficePreviewRenderer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.readBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
    mocks.isLegacyExcel.mockReturnValue(false)
    mocks.render.mockResolvedValue(vi.fn())
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('reads, validates, and renders a managed artifact without exposing its path to the library', async () => {
    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    expect(mocks.readBytes).toHaveBeenCalledWith(
      '/artifacts/report.docx',
      'artifact',
      10 * 1024 * 1024
    )
    expect(mocks.validate).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'docx',
      expect.any(AbortSignal)
    )
    expect(mocks.render).toHaveBeenCalledWith({
      bytes: expect.any(Uint8Array),
      extension: 'docx',
      name: 'report.docx',
      container: expect.any(HTMLDivElement),
      scrollContainer: expect.any(HTMLDivElement),
      signal: expect.any(AbortSignal)
    })
    expect(mocks.render.mock.calls[0][0]).not.toHaveProperty('path')
    expect(container.querySelector('.office-preview-content')).not.toBeNull()
  })

  it('re-reads a finalized upload path and disposes the pending render', async () => {
    const disposePending = vi.fn()
    mocks.render.mockResolvedValueOnce(disposePending).mockResolvedValueOnce(vi.fn())

    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({
            source: 'upload',
            path: '/uploads/.pending/results.xlsx',
            name: 'results.xlsx',
            format: 'spreadsheet'
          })}
        />
      )
      await flushMicrotasks()
    })

    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({
            source: 'upload',
            path: '/uploads/session-1/results.xlsx',
            name: 'results.xlsx',
            format: 'spreadsheet'
          })}
        />
      )
      await flushMicrotasks()
    })

    expect(disposePending).toHaveBeenCalledOnce()
    expect(mocks.readBytes).toHaveBeenLastCalledWith(
      '/uploads/session-1/results.xlsx',
      'upload',
      50 * 1024 * 1024
    )
    expect(mocks.validate).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      'xlsx',
      expect.any(AbortSignal)
    )
  })

  it('isolates a stale renderer from the next file preview', async () => {
    let releaseStaleRender: (() => void) | undefined
    const staleRenderGate = new Promise<void>((resolve) => {
      releaseStaleRender = resolve
    })

    mocks.render
      .mockImplementationOnce(
        async ({ container: target }: { container: HTMLElement }): Promise<() => void> => {
          await staleRenderGate
          target.textContent = 'stale preview'
          return () => target.replaceChildren()
        }
      )
      .mockImplementationOnce(
        async ({ container: target }: { container: HTMLElement }): Promise<() => void> => {
          target.textContent = 'current preview'
          return () => target.replaceChildren()
        }
      )

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({
            id: 'office-2',
            path: '/artifacts/current.docx',
            name: 'current.docx',
            title: 'current.docx'
          })}
        />
      )
      await flushMicrotasks()
    })

    expect(container.textContent).toContain('current preview')
    expect(mocks.render.mock.calls[0][0].container).not.toBe(
      mocks.render.mock.calls[1][0].container
    )

    await act(async () => {
      releaseStaleRender?.()
      await flushMicrotasks()
    })

    expect(container.textContent).toContain('current preview')
    expect(container.textContent).not.toContain('stale preview')
  })

  it('detects a legacy Excel file from CFB bytes when its name has no extension', async () => {
    mocks.isLegacyExcel.mockReturnValue(true)

    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({ name: 'legacy-upload', format: 'spreadsheet' })}
        />
      )
      await flushMicrotasks()
    })

    expect(mocks.validate).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'xls',
      expect.any(AbortSignal)
    )
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ extension: 'xls', name: 'legacy-upload' })
    )
  })

  it('blocks links created by Office documents', async () => {
    mocks.render.mockImplementation(async ({ container: target }: { container: HTMLElement }) => {
      const link = document.createElement('a')
      link.href = 'https://example.com'
      link.textContent = 'external'
      target.appendChild(link)
      return vi.fn()
    })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    expect(container.querySelector('a')?.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('shows a preview fallback when validation or rendering fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.validate.mockImplementation(() => {
      throw new Error('invalid package')
    })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    expect(container.textContent).toContain("This Office file couldn't be rendered for preview")
    expect(consoleError).toHaveBeenCalledWith('Failed to render Office preview', expect.any(Error))
  })

  it('aborts a render that exceeds the preview timeout', async () => {
    vi.useFakeTimers()
    mocks.render.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    const signal = mocks.render.mock.calls[0][0].signal as AbortSignal

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TIMEOUT_MS)
    })

    expect(signal.aborted).toBe(true)
    expect(container.textContent).toContain('This Office file took too long to preview')
  })

  it('keeps a larger timeout for large spreadsheet parsing', async () => {
    vi.useFakeTimers()
    mocks.render.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({
            format: 'spreadsheet',
            name: 'large.xlsx',
            size: 40 * 1024 * 1024
          })}
        />
      )
      await flushMicrotasks()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TIMEOUT_MS)
    })
    expect(container.textContent).not.toContain('This Office file took too long to preview')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS - OFFICE_PREVIEW_TIMEOUT_MS
      )
    })
    expect(container.textContent).toContain('This Office file took too long to preview')
  })

  it.each([
    {
      label: 'regular Office files',
      item: createItem(),
      initialTimeout: OFFICE_PREVIEW_TIMEOUT_MS,
      retryTimeout: OFFICE_PREVIEW_TIMEOUT_MS * 2
    },
    {
      label: 'large spreadsheets',
      item: createItem({
        format: 'spreadsheet',
        name: 'large.xlsx',
        size: 40 * 1024 * 1024
      }),
      initialTimeout: LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS,
      retryTimeout: LARGE_SPREADSHEET_PREVIEW_TIMEOUT_MS * 2
    }
  ])(
    'uses the default timeout once and a fixed doubled timeout for every retry of $label',
    async ({ item, initialTimeout, retryTimeout }) => {
      vi.useFakeTimers()
      mocks.render.mockReturnValue(new Promise(() => undefined))

      await act(async () => {
        root.render(<PreviewFileContent item={item} />)
        await flushMicrotasks()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(initialTimeout)
      })
      expect(container.textContent).toContain('Preview timed out')

      const clickRetry = async (): Promise<void> => {
        const retry = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Retry'
        )
        expect(retry).toBeDefined()
        await act(async () => {
          retry?.click()
          await flushMicrotasks()
        })
      }

      await clickRetry()
      const firstRetrySignal = mocks.render.mock.calls[1]?.[0].signal as AbortSignal
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryTimeout - 1)
      })
      expect(firstRetrySignal.aborted).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(firstRetrySignal.aborted).toBe(true)

      await clickRetry()
      const secondRetrySignal = mocks.render.mock.calls[2]?.[0].signal as AbortSignal
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryTimeout)
      })
      expect(secondRetrySignal.aborted).toBe(true)
    }
  )
})
