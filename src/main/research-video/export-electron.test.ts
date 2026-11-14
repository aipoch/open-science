import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { renderResearchVideoMp4 } from './export-electron'

const electron = vi.hoisted(() => {
  const clearData = vi.fn(async () => {})
  const loadURL = vi.fn(async () => {})
  const executeJavaScript = vi.fn<() => Promise<unknown>>(async () => ({
    W: 0,
    H: 0,
    duration: 0
  }))
  const destroy = vi.fn()
  const protocol = { handle: vi.fn(), unhandle: vi.fn() }
  const fromPartition = vi.fn(() => ({
    clearData,
    clearStorageData: clearData,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
    protocol
  }))
  const BrowserWindow = vi.fn(function () {
    return {
      loadURL,
      destroy,
      isDestroyed: () => false,
      webContents: { executeJavaScript, setWindowOpenHandler: vi.fn(), on: vi.fn() }
    }
  })
  return { clearData, loadURL, executeJavaScript, destroy, protocol, fromPartition, BrowserWindow }
})

vi.mock('@aipoch/research-film/export', () => ({
  exportResearchVideoMp4: ({ outputPath }: { outputPath: string }) =>
    writeFile(outputPath, 'verified video')
}))

vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  session: { fromPartition: electron.fromPartition }
}))

it('cancels queued exports and holds the shared partition until teardown completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-video-electron-'))
  const cleaning = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const first = new AbortController()
  const cancelled = new AbortController()
  const second = new AbortController()
  const exports: Promise<unknown>[] = []
  const start = (name: string, controller: AbortController): Promise<unknown> => {
    const task = renderResearchVideoMp4(
      { htmlPath: join(root, `${name}.html`), encoderPath: '', probePath: '' },
      controller.signal
    ).catch((error: unknown) => error)
    exports.push(task)
    return task
  }
  electron.clearData.mockImplementationOnce(() => {
    cleaning.resolve()
    return cleaned.promise
  })
  try {
    await Promise.all(
      ['first', 'second'].map((name) =>
        writeFile(
          join(root, `${name}.html`),
          '<meta name="open-science-research-video" content="1">'
        )
      )
    )
    const firstExport = start('first', first)
    await cleaning.promise

    const cancelledExport = start('missing', cancelled)
    const secondExport = start('second', second)
    const reason = new Error('cancelled while waiting')
    cancelled.abort(reason)
    expect(await cancelledExport).toBe(reason)
    expect(electron.BrowserWindow).toHaveBeenCalledOnce()
    expect(electron.protocol.unhandle).toHaveBeenCalledWith('https')

    cleaned.resolve()
    expect(await firstExport).toEqual(new Error('Invalid research video stage'))
    expect(await secondExport).toEqual(new Error('Invalid research video stage'))
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(2)
    expect(electron.fromPartition).toHaveBeenCalledOnce()
    expect(electron.destroy).toHaveBeenCalledTimes(2)
    expect(electron.loadURL.mock.calls[0]).not.toEqual(electron.loadURL.mock.calls[1])

    electron.clearData.mockRejectedValueOnce(new Error('clear failed'))
    expect(await start('first', first)).toEqual(new Error('Invalid research video stage'))
    electron.clearData.mockRejectedValueOnce(new Error('still dirty'))
    expect(await start('second', second)).toEqual(new Error('still dirty'))
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(3)
    expect(await start('second', second)).toEqual(new Error('Invalid research video stage'))
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(4)
  } finally {
    first.abort()
    cancelled.abort()
    second.abort()
    cleaned.resolve()
    await Promise.all(exports)
    await rm(root, { force: true, recursive: true })
  }
})

it('keeps a completed export when browser data cleanup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-video-electron-'))
  const htmlPath = join(root, 'player.html')
  try {
    await writeFile(htmlPath, '<meta name="open-science-research-video" content="1">')
    electron.executeJavaScript
      .mockResolvedValueOnce({ W: 1920, H: 1080, duration: 1 })
      .mockResolvedValueOnce('data:audio/wav;base64,YQ==')
    electron.clearData.mockRejectedValueOnce(new Error('clear failed'))
    await expect(
      renderResearchVideoMp4(
        { htmlPath, encoderPath: '', probePath: '' },
        new AbortController().signal
      )
    ).resolves.toBe(`${htmlPath}.mp4`)
    expect(await readFile(`${htmlPath}.mp4`, 'utf8')).toBe('verified video')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
