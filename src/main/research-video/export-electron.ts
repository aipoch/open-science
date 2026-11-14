import type { ResearchVideoProgress, ResearchVideoStep } from '@aipoch/research-film/contracts'
import type { VideoEncoderPaths } from '@aipoch/research-film/export'
import { BrowserWindow, session } from 'electron'
import { readFile, writeFile, rm, mkdtemp, link, rename } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assertVideoEncoderReady,
  exportResearchVideoMp4,
  ResearchVideoEncoderCleanupError
} from '@aipoch/research-film/export'
import { waitForFilmStep } from './wait'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

const log = createLogger('research-video')
const activeProgress = new Map<string, ResearchVideoProgress>()
const renderWaiters = new Set<() => void>()
let renderActive = false
let renderSession: Electron.Session | undefined
let needsReset = false
let resetting: Promise<void> | undefined
let resetTimedOut = false
let playerMounted = false
let activePlayerUrl: string | undefined

const acquireRenderSlot = async (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  if (!renderActive) {
    renderActive = true
    return
  }
  await new Promise<void>((resolve, reject) => {
    const grant = (): void => {
      renderWaiters.delete(grant)
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    const cancel = (): void => {
      renderWaiters.delete(grant)
      reject(signal.reason)
    }
    renderWaiters.add(grant)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

const resetRenderSession = async (
  isolated: Electron.Session,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted()
  const error = new Error('Film export browser cleanup timed out.')
  if (resetTimedOut) throw error
  const pending = (resetting ??= Promise.resolve()
    .then(async () => {
      activePlayerUrl = undefined
      if (playerMounted) {
        isolated.protocol.unhandle('https')
        playerMounted = false
      }
      await isolated.clearData()
      needsReset = false
    })
    .finally(() => {
      resetting = undefined
      resetTimedOut = false
    }))
  const deadline = new AbortController()
  const timer = setTimeout(() => {
    resetTimedOut = true
    deadline.abort(error)
  }, 5_000)
  return waitForFilmStep(
    signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    () => pending
  ).finally(() => clearTimeout(timer))
}

const createRenderSession = (): Electron.Session => {
  const isolated = session.fromPartition('research-video-export', { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== activePlayerUrl && !details.url.startsWith('data:') })
  )
  return isolated
}

export const readResearchVideoExportProgress = (request: {
  htmlPath: string
}): ResearchVideoProgress | null => activeProgress.get(request.htmlPath) ?? null

/** One export owns the dedicated partition through window and browser-data teardown. */
export async function renderResearchVideoMp4(
  request: { htmlPath: string } & VideoEncoderPaths,
  parentSignal: AbortSignal
): Promise<string> {
  await acquireRenderSlot(parentSignal)
  try {
    parentSignal.throwIfAborted()
    assertVideoEncoderReady()
    return await renderWithSlot(request, parentSignal)
  } finally {
    const next = renderWaiters.values().next().value
    if (next) next()
    else renderActive = false
  }
}

async function renderWithSlot(
  request: { htmlPath: string } & VideoEncoderPaths,
  parentSignal: AbortSignal
): Promise<string> {
  const timeout = new AbortController()
  const signal = AbortSignal.any([parentSignal, timeout.signal])
  const { encoderPath, probePath } = request
  const startedAt = Date.now()
  const report = (step: ResearchVideoStep): void => {
    activeProgress.set(request.htmlPath, { ...step, startedAt })
  }
  signal.throwIfAborted()
  const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const html = await waitForFilmStep(setupSignal, () =>
    readFile(request.htmlPath, { encoding: 'utf8', signal: setupSignal })
  )
  if (
    Buffer.byteLength(html) > 200 * 1024 * 1024 ||
    !html.includes('<meta name="open-science-research-video" content="1">')
  )
    throw new Error('Not a supported research video player')
  const isolated = (renderSession ??= createRenderSession())
  if (needsReset) await resetRenderSession(isolated, signal)
  signal.throwIfAborted()
  const playerUrl = `https://research-video.invalid/player?render&ratio=16x9&job=${randomUUID()}`
  const outputPath = `${request.htmlPath}.mp4`
  let activeWindow: BrowserWindow | undefined
  let directory: string | undefined
  let encoderExit: Promise<void> | undefined
  needsReset = true
  try {
    isolated.protocol.handle(
      'https',
      (request) =>
        new Response(request.url === playerUrl ? html : '', {
          status: request.url === playerUrl ? 200 : 403,
          headers: {
            'content-type': 'text/html',
            'content-security-policy':
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
          }
        })
    )
    playerMounted = true
    activePlayerUrl = playerUrl
    const window = (activeWindow = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      useContentSize: true,
      webPreferences: {
        session: isolated,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    }))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    report({ phase: 'preparing' })
    const timer = setTimeout(
      () => timeout.abort(new Error('Video export timed out')),
      60 * 60 * 1000
    )
    const renderCall = <T>(call: () => Promise<T>): Promise<T> => waitForFilmStep(setupSignal, call)
    try {
      await renderCall(() => window.loadURL(playerUrl))
      signal.throwIfAborted()
      const metadata = (await renderCall(() =>
        window.webContents.executeJavaScript('window.__ready')
      )) as {
        duration: number
        W: number
        H: number
      }
      if (
        metadata.W !== 1920 ||
        metadata.H !== 1080 ||
        !Number.isFinite(metadata.duration) ||
        metadata.duration <= 0 ||
        metadata.duration > 3600
      )
        throw new Error('Invalid research video stage')
      signal.throwIfAborted()
      const audio: unknown = await renderCall(() =>
        window.webContents.executeJavaScript("window.VIDEO_ASSETS['mix.wav']")
      )
      if (
        typeof audio !== 'string' ||
        !audio.startsWith('data:audio/wav;base64,') ||
        audio.length > 140 * 1024 * 1024
      )
        throw new Error('Invalid narration audio')
      // The backend can remove its staging directory as soon as native RPC is cancelled.
      // Give the encoder its own audio, output, and any executables staged by that request.
      const staging = dirname(request.htmlPath)
      const owned = (directory = await mkdtemp(join(dirname(staging), 'film-encode-')))
      const moveTool = async (source: string, name: string): Promise<string> => {
        if (relative(staging, dirname(source)) !== '') return source
        const path = join(owned, name)
        await rename(source, path)
        return path
      }
      const encoder = await moveTool(
        encoderPath,
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
      )
      const probe = await moveTool(
        probePath,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      )
      const audioPath = join(owned, 'audio.wav')
      const videoPath = join(owned, 'video.mp4')
      await writeFile(
        audioPath,
        Buffer.from(audio.slice('data:audio/wav;base64,'.length), 'base64'),
        { flag: 'wx', signal }
      )
      await exportResearchVideoMp4({
        renderer: {
          async capture(seconds, captureSignal) {
            captureSignal.throwIfAborted()
            await window.webContents.executeJavaScript(
              `window.__seek(${seconds}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
            )
            captureSignal.throwIfAborted()
            const frame = await window.webContents.capturePage({
              x: 0,
              y: 0,
              width: 1920,
              height: 1080
            })
            return frame.resize({ width: 1280, height: 720, quality: 'best' }).toPNG()
          }
        },
        audioPath,
        outputPath: videoPath,
        encoderPath: encoder,
        probePath: probe,
        width: 1280,
        height: 720,
        duration: metadata.duration,
        signal,
        onProgress: (completed, total) => report({ phase: 'rendering', completed, total }),
        onPhase: (phase) => report({ phase })
      })
      signal.throwIfAborted()
      await link(videoPath, outputPath)
    } finally {
      clearTimeout(timer)
    }
    return outputPath
  } catch (error) {
    if (error instanceof ResearchVideoEncoderCleanupError) {
      encoderExit = error.exited
      log.warn('Film encoder shutdown is unconfirmed', diagnosticErrorFields(error))
    }
    throw error
  } finally {
    try {
      if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy()
      await resetRenderSession(isolated).catch((error: unknown) => {
        // Preserve the export result. The next export still has to reset before mounting a player.
        log.warn('Failed to clear Film export browser data', diagnosticErrorFields(error))
      })
    } finally {
      activeProgress.delete(request.htmlPath)
      if (directory) {
        const owned = directory
        const remove = (): Promise<void> =>
          rm(owned, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) =>
            log.warn('Failed to remove Film encoder scratch', diagnosticErrorFields(error))
          )
        if (encoderExit) void encoderExit.then(remove)
        else await remove()
      }
    }
  }
}
