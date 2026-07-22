// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { PreviewRuntimeBoundary } from '../preview-runtime'
import { OfficePreviewRenderer } from './OfficePreview'
import { isOfficePreviewHostVisible } from './office-preview-visibility'

const mocks = vi.hoisted(() => ({
  readBytes: vi.fn(),
  validate: vi.fn(),
  render: vi.fn()
}))

// These legacy calls remain mocked so the migration test can prove the parent renderer stops using them.
vi.mock('../managed-file-bytes', () => ({ readManagedFileBytes: mocks.readBytes }))
vi.mock('../office-package', () => ({
  DOCX_PREVIEW_MAX_COMPRESSED_BYTES: 40 * 1024 * 1024,
  OFFICE_PREVIEW_MAX_COMPRESSED_BYTES: 40 * 1024 * 1024,
  isLegacyExcelFile: vi.fn(() => false),
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
  const setBounds = vi.fn()
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

  beforeEach(() => {
    vi.resetAllMocks()
    stateListener = undefined
    open.mockResolvedValue({
      kind: 'started',
      sessionId: 'office-session-1',
      size: 1024,
      limit: 40 * 1024 * 1024
    })
    setBounds.mockResolvedValue(undefined)
    close.mockResolvedValue(undefined)
    mocks.readBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
    mocks.render.mockResolvedValue(vi.fn())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        officePreview: {
          open,
          setBounds,
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

  it('hides a native preview host outside the viewport or behind a modal', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const visibleRect = {
      left: 10,
      top: 10,
      right: 110,
      bottom: 110,
      width: 100,
      height: 100,
      x: 10,
      y: 10,
      toJSON: () => ({})
    } as DOMRect
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [host])
    })

    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(true)
    expect(isOfficePreviewHostVisible(host, { ...visibleRect, left: -1, x: -1 } as DOMRect)).toBe(
      false
    )

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(false)
    dialog.remove()

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    Object.defineProperty(menu, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...visibleRect, top: 10, bottom: 30, height: 20 })
    })
    document.body.appendChild(menu)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(false)
    menu.remove()
    host.remove()
  })

  it('keeps a native preview host visible while its resizable panel is being dragged', () => {
    const group = document.createElement('div')
    group.dataset.group = 'true'
    const panel = document.createElement('div')
    panel.dataset.panel = 'true'
    panel.style.pointerEvents = 'none'
    const host = document.createElement('div')
    const separator = document.createElement('div')
    separator.dataset.separator = 'active'
    panel.appendChild(host)
    group.append(panel, separator)
    document.body.appendChild(group)
    const visibleRect = {
      left: 10,
      top: 10,
      right: 110,
      bottom: 110,
      width: 100,
      height: 100,
      x: 10,
      y: 10,
      toJSON: () => ({})
    } as DOMRect
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [group])
    })

    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(true)

    group.remove()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('opens an isolated preview session without reading Office bytes in the parent renderer', async () => {
    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    expect(open).toHaveBeenCalledWith({
      requestId: expect.any(String),
      source: 'artifact',
      path: '/artifacts/report.docx',
      name: 'report.docx',
      extension: 'docx',
      attempt: 0
    })
    expect(mocks.readBytes).not.toHaveBeenCalled()
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.render).not.toHaveBeenCalled()
  })

  it('shows the authoritative file-check stage while opening the isolated runtime', async () => {
    open.mockReturnValue(new Promise(() => undefined))

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    expect(container.textContent).toContain('Checking the Office file')
  })

  it('lets the isolated runtime detect an extensionless Excel container from its signature', async () => {
    const item = createItem({
      name: 'legacy-workbook',
      format: 'spreadsheet',
      mimeType: 'application/vnd.ms-excel'
    })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={item} />)
      await flushMicrotasks()
    })

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ extension: 'spreadsheet' }))
  })

  it('uses child runtime phases in the single top-level loading state', async () => {
    const item = createItem({ name: 'results.xlsx', format: 'spreadsheet' })
    await act(async () => {
      root.render(
        <PreviewRuntimeBoundary item={item}>
          <OfficePreviewRenderer item={item} />
        </PreviewRuntimeBoundary>
      )
      await flushMicrotasks()
    })

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

  it('shows a download-only fallback when the authoritative file size exceeds 40 MiB', async () => {
    open.mockResolvedValue({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: 40 * 1024 * 1024 + 1,
      limit: 40 * 1024 * 1024
    })

    await act(async () => {
      root.render(
        <PreviewRuntimeBoundary item={createItem()}>
          <OfficePreviewRenderer item={createItem()} />
        </PreviewRuntimeBoundary>
      )
      await flushMicrotasks()
    })

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
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')

    await act(async () => {
      root.render(
        <PreviewRuntimeBoundary item={createItem()}>
          <OfficePreviewRenderer item={createItem()} />
        </PreviewRuntimeBoundary>
      )
      await flushMicrotasks()
    })

    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'error', error })
    })

    expect(container.textContent).toContain(message)
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Retry')
    expect(disconnect).toHaveBeenCalled()
  })

  it('closes the isolated session and state subscription on unmount', async () => {
    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    await act(async () => root.unmount())

    expect(close).toHaveBeenCalledWith('office-session-1')
    expect(removeStateListener).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  it('applies a child state that arrives before the open response', async () => {
    let resolveOpen:
      | ((value: { kind: 'started'; sessionId: string; size: number; limit: number }) => void)
      | undefined
    open.mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve
      })
    )

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'ready' })
      resolveOpen?.({
        kind: 'started',
        sessionId: 'office-session-1',
        size: 1024,
        limit: 40 * 1024 * 1024
      })
      await flushMicrotasks()
    })

    expect(container.querySelector('[data-office-preview-state="ready"]')).not.toBeNull()
  })

  it('ignores another host state that arrives before its own open response', async () => {
    let resolveOpen:
      | ((value: { kind: 'started'; sessionId: string; size: number; limit: number }) => void)
      | undefined
    open.mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve
      })
    )

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    await act(async () => {
      stateListener?.({
        sessionId: 'another-session',
        requestId: 'another-request',
        phase: 'ready'
      })
      resolveOpen?.({
        kind: 'started',
        sessionId: 'office-session-1',
        size: 1024,
        limit: 40 * 1024 * 1024
      })
      await flushMicrotasks()
    })

    expect(container.querySelector('[data-office-preview-state="loading"]')).not.toBeNull()
    expect(container.querySelector('[data-office-preview-state="ready"]')).toBeNull()
  })

  it('leases one runtime to the top host and restores the previous host on close', async () => {
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

    expect(close).toHaveBeenCalledWith('office-session-1')
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'first.docx' }))
  })

  it('ignores a late terminal state from the previous open generation', async () => {
    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    const previousRequestId = (open.mock.calls[0][0] as { requestId: string }).requestId

    let rejectCurrentOpen: ((error: Error) => void) | undefined
    open.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCurrentOpen = reject
      })
    )
    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({ name: 'next.docx', path: '/artifacts/next.docx' })}
        />
      )
      await flushMicrotasks()
    })

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
    expect(container.textContent).not.toContain('Download')
  })

  it('preserves a terminal child resource error when startup rejects after the child closes', async () => {
    let rejectOpen: ((error: Error) => void) | undefined
    open.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectOpen = reject
      })
    )

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    await act(async () => {
      emitState({
        sessionId: 'office-session-1',
        phase: 'error',
        error: 'RESOURCE_LIMIT_EXCEEDED'
      })
      rejectOpen?.(new Error('closed during startup'))
      await flushMicrotasks()
    })

    expect(container.textContent).toContain('exceeds the safe preview limits')
    expect(container.textContent).toContain('Download')
    expect(container.textContent).not.toContain('Retry')
  })
})
