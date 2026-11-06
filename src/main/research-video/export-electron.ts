import type { ResearchVideoProgress, ResearchVideoStep } from '@aipoch/research-film/contracts'
import type { VideoEncoderPaths } from '@aipoch/research-film/export'
import { BrowserWindow, session } from 'electron'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { exportResearchVideoMp4 } from '@aipoch/research-film/export'

const activeProgress = new Map<string, ResearchVideoProgress>()
export const readResearchVideoExportProgress = (request: {
  htmlPath: string
}): ResearchVideoProgress | null => activeProgress.get(request.htmlPath) ?? null

/** A disposable Chromium session can only load this frozen document; no application bridge. */
export async function renderResearchVideoMp4(
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
  const html = await readFile(request.htmlPath, 'utf8')
  if (
    Buffer.byteLength(html) > 200 * 1024 * 1024 ||
    !html.includes('<meta name="open-science-research-video" content="1">')
  )
    throw new Error('Not a supported research video player')
  const isolated = session.fromPartition(`research-video-${randomUUID()}`, { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !details.url.startsWith('https://research-video.invalid/player') &&
        !details.url.startsWith('data:')
    })
  )
  isolated.protocol.handle(
    'https',
    (request) =>
      new Response(new URL(request.url).hostname === 'research-video.invalid' ? html : '', {
        status: new URL(request.url).hostname === 'research-video.invalid' ? 200 : 403,
        headers: {
          'content-type': 'text/html',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
        }
      })
  )
  const window = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    webPreferences: {
      session: isolated,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const audioPath = `${request.htmlPath}.wav`,
    outputPath = `${request.htmlPath}.mp4`
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let completed = false
  report({ phase: 'preparing' })
  const work = (async () => {
    await window.loadURL('https://research-video.invalid/player?render&ratio=16x9')
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
  try {
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
    activeProgress.delete(request.htmlPath)
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    controller.abort(new Error('Video export finished'))
    if (!window.isDestroyed()) window.destroy()
    await work.catch(() => {})
    isolated.protocol.unhandle('https')
    await isolated.clearStorageData()
    await rm(audioPath, { force: true })
    if (!completed) await rm(outputPath, { force: true })
  }
}
