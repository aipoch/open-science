import { ResearchVideoEncoderCleanupError } from '@aipoch/research-film/export'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const encode = vi.hoisted(() =>
  vi.fn(
    async ({
      outputPath
    }: Parameters<typeof import('@aipoch/research-film/export').exportResearchVideoMp4>[0]) => {
      await writeFile(outputPath, 'verified video')
    }
  )
)
vi.mock('@aipoch/research-film/export', async (original) => ({
  ...(await original<typeof import('@aipoch/research-film/export')>()),
  exportResearchVideoMp4: encode
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

it('cancels a player load that never settles after its window is destroyed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-stuck-window-'))
  const htmlPath = join(root, 'player.html')
  const loading = Promise.withResolvers<void>()
  const load = Promise.withResolvers<void>()
  const controller = new AbortController()
  const settled = vi.fn()
  electron.loadURL.mockImplementationOnce(() => {
    loading.resolve()
    return load.promise
  })
  await writeFile(htmlPath, '<meta name="open-science-research-video" content="1">')
  const task = renderResearchVideoMp4(
    { htmlPath, encoderPath: '', probePath: '' },
    controller.signal
  ).then(settled, settled)
  try {
    await loading.promise
    const reason = new Error('Cancelled during load')
    controller.abort(reason)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(reason), { timeout: 300 })
  } finally {
    load.resolve()
    await task
    await rm(root, { force: true, recursive: true })
  }
})

it('bounds partition cleanup without mounting another player on a dirty partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-stuck-reset-'))
  const htmlPath = join(root, 'player.html')
  const clearing = Promise.withResolvers<void>()
  const cleared = Promise.withResolvers<void>()
  const start = (): Promise<unknown> =>
    renderResearchVideoMp4(
      { htmlPath, encoderPath: '', probePath: '' },
      new AbortController().signal
    ).catch((error: unknown) => error)
  electron.clearData.mockImplementationOnce(() => {
    vi.useFakeTimers()
    clearing.resolve()
    return cleared.promise
  })
  await writeFile(htmlPath, '<meta name="open-science-research-video" content="1">')
  const first = start()
  try {
    await clearing.promise
    const mounted = electron.BrowserWindow.mock.calls.length
    const resets = electron.clearData.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(await first).toEqual(new Error('Invalid research video stage'))
    // The prior reset is still pending; trying again must not start a second reset or window.
    expect(await start()).toEqual(new Error('Film export browser cleanup timed out.'))
    expect(electron.clearData).toHaveBeenCalledTimes(resets)
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(mounted)
    cleared.resolve()
    vi.useRealTimers()
    expect(await start()).toEqual(new Error('Invalid research video stage'))
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(mounted + 1)
  } finally {
    cleared.resolve()
    vi.useRealTimers()
    await first
    await rm(root, { force: true, recursive: true })
  }
})

it('keeps encoder inputs when the cancelled backend request deletes its staging directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'film-export-owner-'))
  const staging = join(root, 'backend')
  const htmlPath = join(staging, 'player.html')
  const encoderPath = join(staging, 'ffmpeg')
  const probePath = join(staging, 'ffprobe')
  const ready = Promise.withResolvers<{
    audioPath: string
    encoderPath: string
    probePath: string
  }>()
  const reportFailure = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<void>()
  const cleanupError = new ResearchVideoEncoderCleanupError(exited.promise)
  const controller = new AbortController()
  let task: Promise<unknown> | undefined
  try {
    await mkdir(staging)
    await writeFile(htmlPath, '<meta name="open-science-research-video" content="1">')
    await writeFile(encoderPath, 'encoder')
    await writeFile(probePath, 'probe')
    electron.executeJavaScript
      .mockResolvedValueOnce({ W: 1920, H: 1080, duration: 1 })
      .mockResolvedValueOnce('data:audio/wav;base64,YQ==')
    encode.mockImplementationOnce(async (options) => {
      ready.resolve(options)
      await reportFailure.promise
      throw cleanupError
    })
    task = renderResearchVideoMp4({ htmlPath, encoderPath, probePath }, controller.signal).catch(
      (error: unknown) => error
    )
    const owned = await ready.promise
    controller.abort(new Error('Cancelled over native RPC'))
    await rm(staging, { recursive: true })
    await expect(readFile(owned.audioPath, 'utf8')).resolves.toBe('a')
    await expect(readFile(owned.encoderPath, 'utf8')).resolves.toBe('encoder')
    await expect(readFile(owned.probePath, 'utf8')).resolves.toBe('probe')
    reportFailure.resolve()
    expect(await task).toBe(cleanupError)
    await expect(readFile(owned.audioPath, 'utf8')).resolves.toBe('a')
    exited.resolve()
    await vi.waitFor(() =>
      expect(readFile(owned.audioPath)).rejects.toMatchObject({ code: 'ENOENT' })
    )
  } finally {
    reportFailure.resolve()
    exited.resolve()
    await task
    await rm(root, { recursive: true, force: true })
  }
})
