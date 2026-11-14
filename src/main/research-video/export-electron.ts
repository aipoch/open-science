import type { ResearchVideoProgress, ResearchVideoStep } from '@aipoch/research-film/contracts'
import type { VideoEncoderPaths } from '@aipoch/research-film/export'
import { BrowserWindow, session } from 'electron'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { exportResearchVideoMp4 } from '@aipoch/research-film/export'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

const log = createLogger('research-video')
const activeProgress = new Map<string, ResearchVideoProgress>()
const renderWaiters = new Set<() => void>()
let renderActive = false
let renderSession: Electron.Session | undefined
let needsReset = false
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

const resetRenderSession = async (isolated: Electron.Session): Promise<void> => {
  activePlayerUrl = undefined
  if (playerMounted) {
    isolated.protocol.unhandle('https')
    playerMounted = false
  }
  await isolated.clearData()
  needsReset = false
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
  const controller = new AbortController()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  const { encoderPath, probePath } = request
  const startedAt = Date.now()
  const report = (step: ResearchVideoStep): void => {
    activeProgress.set(request.htmlPath, { ...step, startedAt })
  }
  signal.throwIfAborted()
  const html = await readFile(request.htmlPath, { encoding: 'utf8', signal })
  if (
    Buffer.byteLength(html) > 200 * 1024 * 1024 ||
    !html.includes('<meta name="open-science-research-video" content="1">')
  )
    throw new Error('Not a supported research video player')
  const isolated = (renderSession ??= createRenderSession())
  if (needsReset) await resetRenderSession(isolated)
  signal.throwIfAborted()
  const playerUrl = `https://research-video.invalid/player?render&ratio=16x9&job=${randomUUID()}`
  const audioPath = `${request.htmlPath}.wav`,
    outputPath = `${request.htmlPath}.mp4`
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let activeWindow: BrowserWindow | undefined
  let work: Promise<void> | undefined
  let completed = false
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
    work = (async () => {
      await window.loadURL(playerUrl)
      signal.throwIfAborted()
      const metadata = (await window.webContents.executeJavaScript('window.__ready')) as {
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
      const audio = (await window.webContents.executeJavaScript(
        "window.VIDEO_ASSETS['mix.wav']"
      )) as unknown
      if (
        typeof audio !== 'string' ||
        !audio.startsWith('data:audio/wav;base64,') ||
        audio.length > 140 * 1024 * 1024
      )
        throw new Error('Invalid narration audio')
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
        outputPath,
        encoderPath,
        probePath,
        width: 1280,
        height: 720,
        duration: metadata.duration,
        signal,
        onProgress: (completed, total) => report({ phase: 'rendering', completed, total }),
        onPhase: (phase) => report({ phase })
      })
      completed = true
    })()
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        timer = setTimeout(() => reject(new Error('Video export timed out')), 60 * 60 * 1000)
      })
    ])
    return outputPath
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    controller.abort(new Error('Video export finished'))
    try {
      if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy()
      await work?.catch(() => {})
      await resetRenderSession(isolated).catch((error: unknown) => {
        // Preserve the export result. The next export still has to reset before mounting a player.
        log.warn('Failed to clear Film export browser data', diagnosticErrorFields(error))
      })
    } finally {
      activeProgress.delete(request.htmlPath)
      await rm(audioPath, { force: true })
      if (!completed) await rm(outputPath, { force: true })
    }
  }
}
