// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { PreviewRuntimeBoundary } from '../preview-runtime'
import { OfficePreviewRenderer } from './OfficePreview'
import { isOfficePreviewHostVisible } from './office-preview-visibility'

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
  const captureSnapshot = vi.fn()
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
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.resetAllMocks()
    stateListener = undefined
    open.mockResolvedValue({
      kind: 'started',
      sessionId: 'office-session-1',
      size: 1024,
      limit: 40 * 1024 * 1024
    })
    setBounds.mockResolvedValue(undefined)
    captureSnapshot.mockResolvedValue('data:image/png;base64,c25hcHNob3Q=')
    close.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        officePreview: {
          open,
          setBounds,
          captureSnapshot,
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

    const containingDialog = document.createElement('div')
    containingDialog.setAttribute('role', 'dialog')
    containingDialog.setAttribute('aria-modal', 'true')
    containingDialog.appendChild(host)
    document.body.appendChild(containingDialog)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(true)

    const clippedPanel = document.createElement('div')
    clippedPanel.style.overflow = 'hidden'
    Object.defineProperty(clippedPanel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...visibleRect, right: 60, bottom: 60, width: 50, height: 50 })
    })
    document.body.appendChild(clippedPanel)
    clippedPanel.appendChild(containingDialog)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(true)

    const nestedDialog = document.createElement('div')
    nestedDialog.setAttribute('role', 'dialog')
    document.body.appendChild(nestedDialog)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(false)
    nestedDialog.remove()
    document.body.appendChild(host)
    containingDialog.remove()

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    Object.defineProperty(menu, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...visibleRect, top: 10, bottom: 30, height: 20 })
    })
    document.body.appendChild(menu)
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(false)
    menu.remove()

    const remoteMenu = document.createElement('div')
    remoteMenu.setAttribute('role', 'menu')
    Object.defineProperty(remoteMenu, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        ...visibleRect,
        left: 200,
        right: 260,
        x: 200,
        width: 60,
        top: 10,
        bottom: 30,
        height: 20
      })
    })
    document.body.style.pointerEvents = 'none'
    document.body.appendChild(remoteMenu)
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => [remoteMenu])
    })
    expect(isOfficePreviewHostVisible(host, visibleRect)).toBe(true)
    remoteMenu.remove()
    document.body.style.pointerEvents = ''
    host.remove()
    clippedPanel.remove()
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
    document.body.style.pointerEvents = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
  })

  it('sends normalized viewport bounds once when repeated frames have not changed', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let rect = {
      left: 640.4,
      top: 72.3,
      right: 1260.6,
      bottom: 780.2,
      width: 620.2,
      height: 707.9,
      x: 640.4,
      y: 72.3,
      toJSON: () => ({})
    } as DOMRect
    const getRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => {
        const host = container.querySelector<HTMLElement>('[data-office-preview-state]')
        return host ? [host] : []
      })
    })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    expect(setBounds).toHaveBeenLastCalledWith('office-session-1', {
      x: 640,
      y: 72,
      width: 620,
      height: 708,
      visible: true,
      sequence: 1,
      viewportWidth: 1280,
      viewportHeight: 800
    })

    while (frames.length > 0) frames.shift()?.(0)
    setBounds.mockClear()
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    frames.shift()?.(1)
    expect(setBounds).not.toHaveBeenCalled()

    rect = { ...rect, left: 600.2, x: 600.2, width: 660.4 }
    window.dispatchEvent(new Event('resize'))
    frames.shift()?.(2)
    expect(setBounds).toHaveBeenCalledWith(
      'office-session-1',
      expect.objectContaining({ x: 600, width: 660, sequence: 2 })
    )

    getRect.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  it('observes sibling resizable panels that can move the host without resizing it', async () => {
    const observed: Element[] = []
    class TestResizeObserver {
      observe = vi.fn((element: Element) => observed.push(element))
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const group = document.createElement('div')
    group.dataset.slot = 'resizable-panel-group'
    const leftPanel = document.createElement('div')
    leftPanel.dataset.slot = 'resizable-panel'
    const rightPanel = document.createElement('div')
    rightPanel.dataset.slot = 'resizable-panel'
    document.body.appendChild(group)
    group.append(leftPanel, rightPanel)
    rightPanel.appendChild(container)
    const getRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const geometry =
          this === group
            ? { x: 220, width: 1060 }
            : this === rightPanel
              ? { x: 856, width: 424 }
              : { x: 865, width: 400 }
        return {
          left: geometry.x,
          top: 72,
          right: geometry.x + geometry.width,
          bottom: 780,
          width: geometry.width,
          height: 708,
          x: geometry.x,
          y: 72,
          toJSON: () => ({})
        } as DOMRect
      })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })

    const host = container.querySelector<HTMLElement>('[data-office-preview-state]')
    expect(host).not.toBeNull()
    expect(observed).toEqual(expect.arrayContaining([leftPanel, rightPanel, host]))
    expect(setBounds).toHaveBeenCalledWith(
      'office-session-1',
      expect.objectContaining({
        horizontalLayout: {
          splitGroupX: 220,
          splitGroupWidth: 1060,
          panelX: 856,
          panelWidth: 424
        }
      })
    )

    getRect.mockRestore()
    vi.unstubAllGlobals()
    group.remove()
  })

  it('flushes modal layout mutations before the next paint', async () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let mutationCallback: MutationCallback | undefined
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }

      observe = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
    }
    vi.stubGlobal('MutationObserver', TestMutationObserver)
    let rect = {
      left: 700,
      top: 72,
      right: 1180,
      bottom: 780,
      width: 480,
      height: 708,
      x: 700,
      y: 72,
      toJSON: () => ({})
    } as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    setBounds.mockClear()
    rect = {
      ...rect,
      left: 64,
      top: 40,
      right: 1216,
      bottom: 760,
      width: 1152,
      height: 720,
      x: 64,
      y: 40
    }

    mutationCallback?.(
      [
        {
          type: 'attributes',
          target: container,
          attributeName: 'class'
        } as unknown as MutationRecord
      ],
      {} as MutationObserver
    )

    expect(setBounds).toHaveBeenCalledWith(
      'office-session-1',
      expect.objectContaining({ x: 64, y: 40, width: 1152, height: 720, sequence: 2 })
    )
    expect(frames).toHaveLength(0)
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

  it('shows a captured frame while an overlay intersects the native preview', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let mutationCallback: MutationCallback | undefined
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }
      observe = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
    }
    vi.stubGlobal('MutationObserver', TestMutationObserver)
    const hostRect = {
      left: 600,
      top: 80,
      right: 1000,
      bottom: 680,
      width: 400,
      height: 600,
      x: 600,
      y: 80,
      toJSON: () => ({})
    } as DOMRect
    const getRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => hostRect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'ready' })
      await flushMicrotasks()
    })

    expect(captureSnapshot).toHaveBeenCalledWith('office-session-1')
    expect(
      container
        .querySelector<HTMLImageElement>('[data-office-preview-snapshot]')
        ?.getAttribute('src')
    ).toBe('data:image/png;base64,c25hcHNob3Q=')

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    await act(async () => {
      mutationCallback?.([], {} as MutationObserver)
      frames.shift()?.(0)
      await flushMicrotasks()
      frames.shift()?.(0.5)
      await flushMicrotasks()
    })

    expect(setBounds).toHaveBeenLastCalledWith(
      'office-session-1',
      expect.objectContaining({ visible: false })
    )
    expect(
      container
        .querySelector<HTMLImageElement>('[data-office-preview-snapshot]')
        ?.getAttribute('src')
    ).toBe('data:image/png;base64,c25hcHNob3Q=')

    open.mockResolvedValueOnce({
      kind: 'started',
      sessionId: 'office-session-2',
      size: 2048,
      limit: 40 * 1024 * 1024
    })
    captureSnapshot.mockImplementation((sessionId: string) =>
      sessionId === 'office-session-2'
        ? new Promise<string | undefined>(() => undefined)
        : Promise.resolve('data:image/png;base64,c25hcHNob3Q=')
    )
    await act(async () => {
      root.render(
        <OfficePreviewRenderer
          item={createItem({
            id: 'office-2',
            path: '/artifacts/second.docx',
            name: 'second.docx'
          })}
        />
      )
      await flushMicrotasks()
    })

    expect(container.querySelector('[data-office-preview-snapshot]')).toBeNull()

    menu.remove()
    await act(async () => {
      mutationCallback?.([], {} as MutationObserver)
      frames.shift()?.(1)
      await flushMicrotasks()
    })

    expect(setBounds).toHaveBeenLastCalledWith(
      'office-session-2',
      expect.objectContaining({ visible: true })
    )
    expect(container.querySelector('[data-office-preview-snapshot]')).toBeNull()

    getRect.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  it('commits the latest snapshot before occluding the native preview', async () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let mutationCallback: MutationCallback | undefined
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        mutationCallback = callback
      }
      observe = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
    }
    vi.stubGlobal('MutationObserver', TestMutationObserver)
    const rect = {
      left: 600,
      top: 80,
      right: 1000,
      bottom: 680,
      width: 400,
      height: 600,
      x: 600,
      y: 80,
      toJSON: () => ({})
    } as DOMRect
    const getRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => rect)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

    let resolveOverlaySnapshot: ((url: string) => void) | undefined
    captureSnapshot
      .mockResolvedValueOnce('data:image/png;base64,aW5pdGlhbA==')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveOverlaySnapshot = resolve
          })
      )
    const snapshotsAtOcclusion: Array<string | null> = []
    setBounds.mockImplementation((_sessionId, bounds: { visible: boolean }) => {
      if (!bounds.visible) {
        snapshotsAtOcclusion.push(
          container
            .querySelector<HTMLImageElement>('[data-office-preview-snapshot]')
            ?.getAttribute('src') ?? null
        )
      }
    })

    await act(async () => {
      root.render(<OfficePreviewRenderer item={createItem()} />)
      await flushMicrotasks()
    })
    await act(async () => {
      emitState({ sessionId: 'office-session-1', phase: 'ready' })
      await flushMicrotasks()
    })
    snapshotsAtOcclusion.length = 0

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    await act(async () => {
      mutationCallback?.([], {} as MutationObserver)
      frames.shift()?.(0)
      await flushMicrotasks()
    })

    expect(snapshotsAtOcclusion).toEqual([])

    await act(async () => {
      resolveOverlaySnapshot?.('data:image/png;base64,Y3VycmVudA==')
      await flushMicrotasks()
      frames.shift()?.(1)
      await flushMicrotasks()
    })

    expect(snapshotsAtOcclusion).toEqual(['data:image/png;base64,Y3VycmVudA=='])

    dialog.remove()
    getRect.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
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
