import type { ResearchVideoProgress, ResearchVideoStep } from '@aipoch/research-film/contracts'
import {
  assertResearchVideoPlayerSize,
  filmVisualCheckSchema,
  researchVideoResolutionSchema,
  RESEARCH_VIDEO_EXPORT_OPTIONS,
  researchVideoExportTimeout,
  type ResearchVideoResolution,
  type FilmVisualResult
} from '@aipoch/research-film/contracts'
import type { VideoEncoderPaths } from '@aipoch/research-film/export'
import { BrowserWindow, nativeImage, screen, session } from 'electron'
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

type FilmStage = { duration: number; W: number; H: number }
type FilmViewport = { width: number; height: number }

/** A single isolated partition is shared by HTML review and MP4 capture. */
async function withFilmPlayer<T>(
  htmlPath: string,
  signal: AbortSignal,
  inspectPlayer: (
    window: BrowserWindow,
    metadata: FilmStage,
    setupSignal: AbortSignal,
    viewport: FilmViewport
  ) => Promise<T>,
  resolution?: ResearchVideoResolution,
  aspect: '16x9' | '9x16' = '16x9'
): Promise<T> {
  await acquireRenderSlot(signal)
  try {
    return await openFilmPlayer(htmlPath, signal, inspectPlayer, resolution, aspect)
  } finally {
    const next = renderWaiters.values().next().value
    if (next) next()
    else renderActive = false
  }
}

async function openFilmPlayer<T>(
  htmlPath: string,
  signal: AbortSignal,
  inspectPlayer: (
    window: BrowserWindow,
    metadata: FilmStage,
    setupSignal: AbortSignal,
    viewport: FilmViewport
  ) => Promise<T>,
  resolution?: ResearchVideoResolution,
  aspect: '16x9' | '9x16' = '16x9'
): Promise<T> {
  signal.throwIfAborted()
  const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const html = await waitForFilmStep(setupSignal, () =>
    readFile(htmlPath, { encoding: 'utf8', signal: setupSignal })
  )
  assertResearchVideoPlayerSize(Buffer.byteLength(html))
  if (!html.includes('<meta name="open-science-research-video" content="1">'))
    throw new Error('Not a supported research video player')
  const isolated = (renderSession ??= createRenderSession())
  if (needsReset) await resetRenderSession(isolated, signal)
  signal.throwIfAborted()
  const width = aspect === '9x16' ? 1080 : 1920
  const height = aspect === '9x16' ? 1920 : 1080
  const playerUrl = `https://research-video.invalid/player?render&ar=${aspect}&job=${randomUUID()}`
  let activeWindow: BrowserWindow | undefined
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
      width,
      height,
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
    // Keep the 1920 × 1080 CSS stage and raise its raster density before scripts
    // create canvases. A 1× display must paint real 4K pixels too, not enlarge 1080p.
    const displayScale = resolution ? screen.getDisplayMatching(window.getBounds()).scaleFactor : 1
    if (!Number.isFinite(displayScale) || displayScale <= 0)
      throw new Error('Invalid display scale for video rendering')
    const zoom = resolution
      ? Math.max(1, RESEARCH_VIDEO_EXPORT_OPTIONS[resolution].width / (1920 * displayScale))
      : 1
    const viewport = { width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) }
    if (zoom > 1) window.setContentSize(viewport.width, viewport.height)
    window.webContents.setZoomFactor(zoom)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    const renderCall = <T>(call: () => Promise<T>): Promise<T> => waitForFilmStep(setupSignal, call)
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
      metadata.W !== width ||
      metadata.H !== height ||
      !Number.isFinite(metadata.duration) ||
      metadata.duration <= 0 ||
      metadata.duration > 3600
    )
      throw new Error('Invalid research video stage')
    signal.throwIfAborted()
    return await inspectPlayer(window, metadata, setupSignal, viewport)
  } finally {
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy()
    await resetRenderSession(isolated).catch((error: unknown) =>
      log.warn('Failed to clear Film browser data', diagnosticErrorFields(error))
    )
  }
}
export async function checkResearchVideoHtml(
  request: { htmlPath: string; includeFrames: boolean },
  parentSignal: AbortSignal
): Promise<FilmVisualResult> {
  const check = (aspect: '16x9' | '9x16'): Promise<FilmVisualResult> => {
    return withFilmPlayer(
      request.htmlPath,
      parentSignal,
      async (window, stage) => {
        const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(120_000)])
        const inspect = <T>(work: () => Promise<T>): Promise<T> => waitForFilmStep(signal, work)
        const result = filmVisualCheckSchema.parse(
          await inspect(() => window.webContents.executeJavaScript('window.__checkFilm()'))
        )
        const frames: FilmVisualResult['frames'] = []
        if (aspect === '16x9' && request.includeFrames && !result.issues.length) {
          for (const { scene, time } of result.frames) {
            if (time > stage.duration) throw new Error('Invalid film review time')
            await inspect(() =>
              window.webContents.executeJavaScript(
                `window.__seek(${time}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
              )
            )
            const image = await inspect(() =>
              window.webContents.capturePage({ x: 0, y: 0, width: stage.W, height: stage.H })
            )
            if (image.isEmpty()) throw new Error('The HTML review frame was empty.')
            const jpeg = image
              .resize({ width: 960, height: 540, quality: 'best' })
              .toJPEG(78)
              .toString('base64')
            frames.push({ scene, time, jpeg })
          }
        }
        return {
          issues: result.issues.map((issue) => ({
            ...issue,
            message: (aspect + ': ' + issue.message).slice(0, 500)
          })),
          frames
        }
      },
      undefined,
      aspect
    )
  }
  const portrait = await check('9x16')
  return portrait.issues.length ? portrait : check('16x9')
}

export async function renderResearchVideoMp4(
  request: { htmlPath: string; resolution?: ResearchVideoResolution } & VideoEncoderPaths,
  parentSignal: AbortSignal
): Promise<string> {
  parentSignal.throwIfAborted()
  const resolution = researchVideoResolutionSchema.parse(request.resolution ?? '720p')
  const { width, height } = RESEARCH_VIDEO_EXPORT_OPTIONS[resolution]
  assertVideoEncoderReady()
  const timeout = new AbortController()
  const signal = AbortSignal.any([parentSignal, timeout.signal])
  const { encoderPath, probePath } = request
  const startedAt = Date.now()
  let progress: ResearchVideoProgress | undefined
  const report = (step: ResearchVideoStep): void => {
    progress = { ...step, startedAt }
    activeProgress.set(request.htmlPath, progress)
  }
  const outputPath = `${request.htmlPath}.mp4`
  let directory: string | undefined
  let encoderExit: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await withFilmPlayer(
      request.htmlPath,
      signal,
      async (window, metadata, setupSignal, viewport) => {
        report({ phase: 'preparing' })
        timer = setTimeout(
          () => timeout.abort(new Error('Video export timed out')),
          researchVideoExportTimeout(resolution, metadata.duration)
        )
        const renderCall = <T>(call: () => Promise<T>): Promise<T> =>
          waitForFilmStep(setupSignal, call)
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
                ...viewport
              })
              const scaleFactor = Math.max(1, ...frame.getScaleFactors())
              const size = frame.getSize(scaleFactor)
              const pixelSize = {
                width: Math.round(size.width * scaleFactor),
                height: Math.round(size.height * scaleFactor)
              }
              if (pixelSize.width < width || pixelSize.height < height)
                throw new Error('The video frame is smaller than the selected resolution')
              // NativeImage sizes are in DIPs. Rebase a Retina bitmap to 1× before
              // resizing beyond its DIP size, preserving its existing physical pixels.
              const pixels =
                size.width >= width && size.height >= height
                  ? frame
                  : nativeImage.createFromBitmap(frame.toBitmap({ scaleFactor }), pixelSize)
              return pixels.resize({ width, height, quality: 'best' }).toPNG()
            }
          },
          audioPath,
          outputPath: videoPath,
          encoderPath: encoder,
          probePath: probe,
          width,
          height,
          duration: metadata.duration,
          signal,
          onProgress: (completed, total) => report({ phase: 'rendering', completed, total }),
          onPhase: (phase) => report({ phase })
        })
        signal.throwIfAborted()
        await link(videoPath, outputPath)
        return outputPath
      },
      resolution
    )
  } catch (error) {
    if (error instanceof ResearchVideoEncoderCleanupError) {
      encoderExit = error.exited
      log.warn('Film encoder shutdown is unconfirmed', diagnosticErrorFields(error))
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (progress && activeProgress.get(request.htmlPath) === progress)
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
