import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const native = vi.hoisted(() => ({ createWindow: vi.fn(), metrics: vi.fn(), pdf: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppMetrics: native.metrics },
  BrowserWindow: vi.fn(function (options) {
    return native.createWindow(options)
  })
}))
vi.mock('../uploads/attachment-media', () => ({ renderPdfPagePreviews: native.pdf }))

import {
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS
} from '../../shared/office-preview'
import { OFFICE_PREVIEW_RUNTIME_ORIGIN } from '../office-preview/office-preview-runtime-protocol'
import { createReviewerElectronPagedContentResolver } from './paged-preview-electron'

const request = {
  artifactVersionId: 'version',
  path: resolve('managed', 'report.docx'),
  filename: 'report.docx',
  format: 'docx' as const,
  pages: [2],
  includePreview: true,
  maxBytes: 10_000,
  verifiedObservation: { device: 1, inode: 2, sizeBytes: 100, modifiedAtMs: 3, changedAtMs: 4 },
  verifiedChecksum: 'verified-checksum'
}
type NativeWindow = {
  webContents: EventEmitter & {
    id: number
    getOSProcessId(): number
    setWindowOpenHandler: Mock
    session: { setPermissionRequestHandler: Mock }
    executeJavaScript: Mock
    capturePage: Mock
  }
  loadURL: Mock
  isDestroyed(): boolean
  destroy: Mock
}
const fixture = (): {
  window: NativeWindow
  resources: { acquireResolvedFile: Mock; release: Mock }
  resource: { id: string; url: string; size: number; mimeType: string; version: number }
} => {
  let destroyed = false
  const contents = Object.assign(new EventEmitter(), {
    id: 42,
    getOSProcessId: () => 99,
    setWindowOpenHandler: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn() },
    executeJavaScript: vi
      .fn()
      .mockResolvedValueOnce({ pageCount: 3 })
      .mockResolvedValueOnce({
        pageNumber: 2,
        text: 'Page two',
        rect: { x: 0, y: 0, width: 300, height: 400 }
      }),
    capturePage: vi.fn(async () => ({
      getSize: () => ({ width: 300, height: 400 }),
      resize: vi.fn(),
      toJPEG: () => Buffer.from('image')
    }))
  })
  const window = {
    webContents: contents,
    loadURL: vi.fn(async () => undefined),
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true
    })
  }
  native.createWindow.mockReturnValue(window)
  const resource = {
    id: 'resource',
    url: 'open-science-preview://resource',
    size: 100,
    mimeType: 'application/octet-stream',
    version: 1
  }
  const resources = { acquireResolvedFile: vi.fn(async () => resource), release: vi.fn() }
  return { window, resources, resource }
}

beforeEach(() => {
  vi.resetAllMocks()
  native.metrics.mockReturnValue([])
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Reviewer Electron paged preview adapter', () => {
  it.each([
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
  ] as const)(
    'preserves %s resource admission, isolated window policy and cleanup',
    async (format, mimeType) => {
      const { window, resources, resource } = fixture()
      const resolver = createReviewerElectronPagedContentResolver(resources)
      expect(native.createWindow).not.toHaveBeenCalled()
      const input = {
        ...request,
        path: resolve('managed', `report.${format}`),
        filename: `report.${format}`,
        format
      }
      await expect(resolver(input)).resolves.toMatchObject({
        pageCount: 3,
        pages: [{ pageNumber: 2, text: 'Page two' }],
        media: [{ mimeType: 'image/jpeg' }]
      })
      expect(native.createWindow).toHaveBeenCalledWith({
        show: false,
        width: 1024,
        height: 1280,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          partition: 'reviewer-paged-preview'
        }
      })
      expect(resources.acquireResolvedFile).toHaveBeenCalledWith(
        42,
        {
          path: input.path,
          mimeType,
          verifiedObservation: request.verifiedObservation,
          verifiedChecksum: request.verifiedChecksum
        },
        40 * 1024 * 1024
      )
      const runtimeUrl = new URL(window.loadURL.mock.calls[0][0])
      expect(runtimeUrl.protocol).toBe(new URL(OFFICE_PREVIEW_RUNTIME_ORIGIN).protocol)
      expect(runtimeUrl.hostname).toBe(new URL(OFFICE_PREVIEW_RUNTIME_ORIGIN).hostname)
      expect(runtimeUrl.pathname).toBe('/reviewer-paged-preview.html')
      const sessionId = runtimeUrl.searchParams.get('sessionId')
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(window.webContents.executeJavaScript.mock.calls[0][0]).toBe(
        `window.__openScienceReviewerPagedPreview.initialize(${JSON.stringify({ sessionId, resource, format, pages: [2] })})`
      )
      expect(window.destroy).toHaveBeenCalledOnce()
      expect(resources.release).toHaveBeenCalledWith(42, { resourceId: 'resource' })

      const contents = window.webContents
      expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
      for (const url of [
        runtimeUrl.toString(),
        'https://example.com/',
        'file:///tmp/report.html',
        `${runtimeUrl.protocol}//other/reviewer-paged-preview.html`
      ]) {
        const event = { preventDefault: vi.fn() }
        contents.emit('will-navigate', event, url)
        expect(event.preventDefault).toHaveBeenCalledTimes(url === runtimeUrl.toString() ? 0 : 1)
      }
      const permissionResult = vi.fn()
      contents.session.setPermissionRequestHandler.mock.calls[0][0](
        contents,
        'media',
        permissionResult
      )
      expect(permissionResult).toHaveBeenCalledWith(false)
    }
  )

  it('forwards PDF requests and cancellation to the existing renderer without an Office window', async () => {
    const { resources } = fixture()
    native.pdf.mockResolvedValue({ pageCount: 3, media: [], budgetExhaustedPages: [2] })
    const signal = new AbortController().signal
    const input = {
      ...request,
      format: 'pdf' as const,
      filename: 'report.pdf',
      path: resolve('managed', 'report.pdf'),
      signal
    }
    await expect(
      createReviewerElectronPagedContentResolver(resources)(input)
    ).resolves.toMatchObject({
      pages: [{ pageNumber: 2, text: '' }],
      limitations: [{ kind: 'budget-exhausted' }]
    })
    expect(native.pdf).toHaveBeenCalledWith(input.path, [2], input.maxBytes, signal)
    expect(native.createWindow).not.toHaveBeenCalled()
    expect(resources.acquireResolvedFile).not.toHaveBeenCalled()
  })

  it('destroys the hidden window without releasing an unacquired resource on admission failure', async () => {
    const { window, resources } = fixture()
    const failure = new Error('verified source changed')
    resources.acquireResolvedFile.mockRejectedValue(failure)
    await expect(createReviewerElectronPagedContentResolver(resources)(request)).rejects.toBe(
      failure
    )
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(resources.release).not.toHaveBeenCalled()
  })

  it('releases the same shared resource after native runtime loading fails', async () => {
    const { window, resources } = fixture()
    const failure = new Error('runtime load failed')
    window.loadURL.mockRejectedValue(failure)
    await expect(createReviewerElectronPagedContentResolver(resources)(request)).rejects.toBe(
      failure
    )
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(resources.release).toHaveBeenCalledExactlyOnceWith(42, { resourceId: 'resource' })
  })

  it('binds Electron process metrics to the existing memory guard', async () => {
    vi.useFakeTimers()
    const { window, resources } = fixture()
    window.webContents.executeJavaScript
      .mockReset()
      .mockImplementation(() => new Promise(() => undefined))
    native.metrics.mockReturnValue([
      { pid: 99, memory: { privateBytes: OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES / 1024 } }
    ])
    const pending = createReviewerElectronPagedContentResolver(resources)(request)
    const rejection = expect(pending).rejects.toThrow('exceeded its memory limit')
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
    await rejection
    expect(native.metrics).toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(resources.release).toHaveBeenCalledExactlyOnceWith(42, { resourceId: 'resource' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
