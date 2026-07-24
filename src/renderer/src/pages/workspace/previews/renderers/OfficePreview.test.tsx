// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import {
  OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
  OFFICE_PREVIEW_FRAME_MESSAGE_VERSION
} from '../../../../../../shared/office-preview'
import { PreviewRuntimeBoundary } from '../preview-runtime'
import { OfficePreviewRenderer } from './OfficePreview'

const OFFICE_PREVIEW_RUNTIME_ORIGIN = 'open-science-office-preview://runtime'

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

const startedResult = (
  sessionId = 'office-session-1'
): {
  kind: 'started'
  sessionId: string
  runtimeUrl: string
  size: number
  limit: number
} => ({
  kind: 'started' as const,
  sessionId,
  runtimeUrl: `open-science-office-preview://runtime/office-preview.html?sessionId=${sessionId}`,
  size: 1024,
  limit: 40 * 1024 * 1024
})

describe('OfficePreviewRenderer', () => {
  let container: HTMLDivElement
  let root: Root
  let stateListener:
    | ((state: {
        sessionId: string
        requestId?: string
        phase: string
        title?: string
        error?: string
      }) => void)
    | undefined
  const open = vi.fn()
  const attachFrame = vi.fn()
  const reportState = vi.fn()
  const close = vi.fn()
  const removeStateListener = vi.fn()

  const emitState = (state: {
    sessionId: string
    phase: string
    title?: string
    error?: string
  }): void => {
    const requestId = (open.mock.calls.at(-1)?.[0] as { requestId?: string } | undefined)?.requestId
    stateListener?.({ ...state, requestId })
  }

  const renderPreview = async (item = createItem(), withRuntimeBoundary = false): Promise<void> => {
    await act(async () => {
      root.render(
        withRuntimeBoundary ? (
          <PreviewRuntimeBoundary item={item}>
            <OfficePreviewRenderer item={item} />
          </PreviewRuntimeBoundary>
        ) : (
          <OfficePreviewRenderer item={item} />
        )
      )
      await flushMicrotasks()
    })
  }

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    stateListener = undefined
    open.mockResolvedValue(startedResult())
    attachFrame.mockResolvedValue({
      kind: 'attached',
      start: {
        sessionId: 'office-session-1',
        resource: {
          id: 'resource-1',
          url: 'open-science-preview://resource-1/report.docx',
          size: 1024,
          mimeType: 'application/octet-stream',
          version: 1
        },
        extension: 'docx',
        name: 'report.docx',
        attempt: 0
      }
    })
    close.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        officePreview: {
          open,
          attachFrame,
          reportState,
          close,
          onState: vi.fn((listener) => {
            stateListener = listener
            return removeStateListener
          })
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.querySelectorAll('[data-test-overlay]').forEach((element) => element.remove())
  })

  it('shows the authoritative file-check stage while opening', async () => {
    open.mockReturnValue(new Promise(() => undefined))

    await renderPreview()

    expect(container.textContent).toContain('Checking the Office file')
  })

  it('embeds the Office runtime as a sandboxed cross-site iframe', async () => {
    await renderPreview()

    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    expect(frame?.src).toBe(startedResult().runtimeUrl)
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('attaches on iframe load before relaying start and runtime state', async () => {
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    expect(frame?.contentWindow).toBeTruthy()
    const postMessage = vi.spyOn(frame!.contentWindow!, 'postMessage')

    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })

    expect(attachFrame).toHaveBeenCalledWith('office-session-1')
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', sessionId: 'office-session-1' }),
      OFFICE_PREVIEW_RUNTIME_ORIGIN
    )

    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame!.contentWindow,
        origin: OFFICE_PREVIEW_RUNTIME_ORIGIN,
        data: {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'state',
          sessionId: 'office-session-1',
          state: { sessionId: 'office-session-1', phase: 'ready' }
        }
      })
    )
    expect(reportState).toHaveBeenCalledWith('office-session-1', {
      sessionId: 'office-session-1',
      phase: 'ready'
    })
  })

  it('ignores state messages from other windows and sessions', async () => {
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'state',
          sessionId: 'office-session-1',
          state: { sessionId: 'office-session-1', phase: 'ready' }
        }
      })
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame!.contentWindow,
        data: {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'state',
          sessionId: 'another-session',
          state: { sessionId: 'another-session', phase: 'ready' }
        }
      })
    )

    expect(reportState).not.toHaveBeenCalled()
  })

  it('ignores runtime state from an unexpected origin', async () => {
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })

    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame!.contentWindow,
        origin: 'https://malicious.example',
        data: {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'state',
          sessionId: 'office-session-1',
          state: { sessionId: 'office-session-1', phase: 'ready' }
        }
      })
    )

    expect(reportState).not.toHaveBeenCalled()
  })

  it('reattaches and resends start when the same iframe reloads', async () => {
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    const postMessage = vi.spyOn(frame!.contentWindow!, 'postMessage')

    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })
    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })

    expect(attachFrame).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'start', sessionId: 'office-session-1' }),
      OFFICE_PREVIEW_RUNTIME_ORIGIN
    )
  })

  it('closes the main-process session immediately when frame attachment rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    attachFrame.mockRejectedValueOnce(new Error('IPC failed'))
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')

    await act(async () => {
      frame!.dispatchEvent(new Event('load'))
      await flushMicrotasks()
    })

    expect(close).toHaveBeenCalledWith('office-session-1')
    expect(container.textContent).toContain("This Office file couldn't be rendered for preview")
    errorSpy.mockRestore()
  })

  it('keeps the same iframe mounted through resize and modal lifecycle changes', async () => {
    await renderPreview()
    const frame = container.querySelector<HTMLIFrameElement>('[data-office-preview-frame]')
    const originalUrl = frame?.src

    window.dispatchEvent(new Event('resize'))
    const dialog = document.createElement('div')
    dialog.dataset.testOverlay = 'true'
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await renderPreview()
    dialog.remove()
    window.dispatchEvent(new Event('resize'))

    expect(container.querySelector('[data-office-preview-frame]')).toBe(frame)
    expect(frame?.src).toBe(originalUrl)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each([
    [createItem(), 'docx'],
    [createItem({ format: 'presentation', name: 'slides.pptx' }), 'pptx'],
    [createItem({ format: 'spreadsheet', name: 'book.xlsx' }), 'xlsx'],
    [createItem({ format: 'spreadsheet', name: 'legacy.xls' }), 'xls'],
    [createItem({ format: 'spreadsheet', name: 'extensionless' }), 'spreadsheet']
  ])('routes each supported Office format to the isolated runtime', async (item, extension) => {
    await renderPreview(item)

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ extension }))
  })

  it('uses runtime phases in one top-level loading state', async () => {
    await renderPreview(createItem({ format: 'spreadsheet', name: 'results.xlsx' }), true)

    await act(async () => {
      emitState({
        sessionId: 'office-session-1',
        phase: 'parsing',
        title: 'Parsing the Excel workbook'
      })
    })
    expect(container.textContent).toContain('Parsing the Excel workbook')
    expect(container.querySelectorAll('[data-preview-status="loading"]')).toHaveLength(1)

    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'ready' })
    })
    expect(container.querySelector('[data-preview-status="loading"]')).toBeNull()
    expect(container.querySelector('[data-office-preview-state="ready"]')).not.toBeNull()
  })

  it('shows a download-only fallback when the authoritative size exceeds 40 MiB', async () => {
    open.mockResolvedValue({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: 40 * 1024 * 1024 + 1,
      limit: 40 * 1024 * 1024
    })

    await renderPreview(createItem(), true)

    expect(container.textContent).toContain('File too large to preview')
    expect(container.textContent).toContain('This file is larger than 40 MB. Download it to view.')
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Retry')
  })

  it.each([
    ['INVALID_PACKAGE', 'This Office file is damaged or unsupported. Download it to view.'],
    [
      'RESOURCE_LIMIT_EXCEEDED',
      'This Office file exceeds the safe preview limits. Download it to view.'
    ]
  ])('shows a download-only fallback for %s', async (error, message) => {
    await renderPreview(createItem(), true)

    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'error', error })
    })

    expect(container.textContent).toContain(message)
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Retry')
  })

  it('closes the isolated session and state subscription on unmount', async () => {
    await renderPreview()

    await act(async () => root.unmount())

    expect(close).toHaveBeenCalledWith('office-session-1')
    expect(removeStateListener).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  it('applies a state that arrives before the open response', async () => {
    let resolveOpen: ((value: ReturnType<typeof startedResult>) => void) | undefined
    open.mockReturnValue(new Promise((resolve) => (resolveOpen = resolve)))
    await renderPreview()

    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'ready' })
      resolveOpen?.(startedResult())
      await flushMicrotasks()
    })

    expect(container.querySelector('[data-office-preview-state="ready"]')).not.toBeNull()
  })

  it('ignores a stale state from a previous open generation', async () => {
    await renderPreview()
    const previousRequestId = (open.mock.calls[0][0] as { requestId: string }).requestId
    let rejectCurrentOpen: ((error: Error) => void) | undefined
    open.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectCurrentOpen = reject)))

    await renderPreview(
      createItem({ id: 'office-2', name: 'next.docx', path: '/artifacts/next.docx' })
    )
    await act(async () => {
      stateListener?.({
        sessionId: 'previous-session',
        requestId: previousRequestId,
        phase: 'error',
        error: 'RESOURCE_LIMIT_EXCEEDED'
      })
      rejectCurrentOpen?.(new Error('current startup failed'))
      await flushMicrotasks()
    })

    expect(container.textContent).toContain("This Office file couldn't be rendered for preview")
    expect(container.textContent).not.toContain('exceeds the safe preview limits')
  })

  it('leases the runtime to only the top preview host', async () => {
    const first = createItem({ id: 'first', name: 'first.docx', path: '/artifacts/first.docx' })
    const second = createItem({ id: 'second', name: 'second.docx', path: '/artifacts/second.docx' })

    await act(async () => {
      root.render(
        <>
          <OfficePreviewRenderer key="first" item={first} />
          <OfficePreviewRenderer key="second" item={second} />
        </>
      )
      await flushMicrotasks()
    })
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'second.docx' }))

    await act(async () => {
      root.render(<OfficePreviewRenderer key="first" item={first} />)
      await flushMicrotasks()
    })
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'first.docx' }))
  })
})
