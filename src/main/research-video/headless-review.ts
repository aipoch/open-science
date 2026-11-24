import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import {
  RESEARCH_VIDEO_EXPORT_OPTIONS,
  researchVideoExportTimeout,
  type FilmVisualIssue,
  type ResearchVideoResolution
} from '@aipoch/research-film/contracts'
import {
  assertVideoEncoderReady,
  exportResearchVideoMp4,
  type VideoEncoderPaths
} from '@aipoch/research-film/export'
import {
  filmPlayerCsp,
  filmStageSize,
  readFilmObservations,
  readFilmStage,
  verifyFilmPlayerHtml,
  type FilmAspect,
  type FilmStage
} from './player-review'
import { waitForFilmStep } from './wait'

const browserVariable = 'OPEN_SCIENCE_RESEARCH_FILM_BROWSER'

function standardBrowserPaths(): string[] {
  switch (process.platform) {
    case 'win32':
      return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
        .filter((directory): directory is string => !!directory && isAbsolute(directory))
        .flatMap((directory) => [
          join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
        ])
    case 'darwin':
      return ['Google Chrome', 'Chromium', 'Microsoft Edge'].map(
        (app) => `/Applications/${app}.app/Contents/MacOS/${app}`
      )
    case 'linux':
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
        '/snap/bin/chromium'
      ]
    default:
      return []
  }
}

export async function locateResearchFilmBrowser(): Promise<string> {
  const configured = process.env[browserVariable]
  for (const path of configured === undefined ? standardBrowserPaths() : [configured]) {
    if (!isAbsolute(path)) continue
    try {
      if (!(await stat(path)).isFile()) continue
      await access(path, constants.X_OK)
      return path
    } catch {
      continue
    }
  }
  throw new Error(
    configured === undefined
      ? `Headless Research Film review or MP4 export needs Chrome, Chromium, or Microsoft Edge. Install a browser or set ${browserVariable} to its executable path before starting Open Science.`
      : `The browser specified by ${browserVariable} is not executable. Use an absolute browser executable path and restart Open Science.`
  )
}

function browserEnvironment(): NodeJS.ProcessEnv {
  // The browser needs system paths and locale, but has no use for provider credentials or proxies.
  const systemVariable =
    /^(?:PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|OS|HOME|USER|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|LANG|LC_\w+|XDG_RUNTIME_DIR)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => systemVariable.test(key)))
}

async function openFilmBrowser(): Promise<Browser> {
  const executablePath = await locateResearchFilmBrowser()
  try {
    const { chromium } = await import('playwright-core')
    return await chromium.launch({
      executablePath,
      env: browserEnvironment(),
      headless: true,
      chromiumSandbox: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 15_000,
      ignoreDefaultArgs: ['--disable-popup-blocking', '--disable-ipc-flooding-protection'],
      args: [
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
      ]
    })
  } catch (error) {
    throw new Error(
      'The Research Film browser could not start with its sandbox enabled. Check the browser installation and service account.',
      { cause: error }
    )
  }
}

export async function assertHeadlessResearchFilmReady(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const browser = await openFilmBrowser()
  await browser.close()
  signal.throwIfAborted()
}

async function withFilmPlayer<T>(
  browser: Browser,
  html: string,
  aspect: FilmAspect,
  parentSignal: AbortSignal,
  inspect: (page: Page, stage: FilmStage, setupSignal: AbortSignal) => Promise<T>,
  deviceScaleFactor = 1
): Promise<T> {
  const setupSignal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
  const setup = <T>(work: () => Promise<T>): Promise<T> => waitForFilmStep(setupSignal, work)
  const viewport = filmStageSize(aspect)
  const url = `https://research-video.invalid/player?render&ar=${aspect}&job=${randomUUID()}`
  const context = await setup(() =>
    browser.newContext({
      viewport,
      deviceScaleFactor,
      offline: true,
      permissions: [],
      acceptDownloads: false,
      serviceWorkers: 'block'
    })
  )
  await setup(() => context.routeWebSocket('**/*', (socket) => socket.close()))
  const page = await setup(() => context.newPage())
  // WebRTC has its own transport outside ordinary request routing and the player's CSP.
  await page.addInitScript(`for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      Object.defineProperty(window, key, { value: undefined, configurable: false });
    }`)
  page.on('popup', (popup) => void popup.close().catch(() => {}))
  let served = false
  await context.route('**/*', async (route) => {
    const request = route.request()
    if (
      served ||
      request.url() !== url ||
      request.method() !== 'GET' ||
      !request.isNavigationRequest()
    ) {
      await route.abort('blockedbyclient')
      return
    }
    served = true
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `${filmPlayerCsp}; worker-src 'none'; object-src 'none'`,
        'x-content-type-options': 'nosniff'
      },
      body: html
    })
  })
  await setup(() => page.goto(url))
  const stage = readFilmStage(
    await setup(() =>
      page.evaluate('Promise.resolve().then(() => window.__ready).catch(() => null)')
    ),
    aspect
  )
  const result = await inspect(page, stage, setupSignal)
  await context.close()
  return result
}

async function withFilmBrowser<T>(
  signal: AbortSignal,
  run: (browser: Browser) => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  const browser = await openFilmBrowser()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= browser.close())
  const onAbort = (): void => {
    void close().catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const result = await run(browser)
    await close()
    return result
  } catch (error) {
    // Preserve the encoder cleanup error so its caller can wait for the child before removing files.
    await close().catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function checkHeadlessResearchFilmHtml(
  htmlPath: string,
  signal: AbortSignal
): Promise<FilmVisualIssue[]> {
  signal.throwIfAborted()
  const html = await readFile(htmlPath, { encoding: 'utf8', signal })
  verifyFilmPlayerHtml(html)
  return withFilmBrowser(signal, async (browser) => {
    const checkAspect = (aspect: FilmAspect): Promise<FilmVisualIssue[]> =>
      withFilmPlayer(browser, html, aspect, signal, async (page, stage) => {
        const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        const observations = await waitForFilmStep(reviewSignal, () =>
          page.evaluate('Promise.resolve().then(() => window.__checkFilm()).catch(() => null)')
        )
        return readFilmObservations(observations, aspect, stage).issues
      })
    return [...(await checkAspect('9x16')), ...(await checkAspect('16x9'))]
  })
}

const wavPrefix = 'data:audio/wav;base64,'
const maxAudioLength = 140 * 1024 * 1024

export async function renderHeadlessResearchFilmMp4(
  {
    html,
    directory,
    resolution,
    encoderPath,
    probePath
  }: VideoEncoderPaths & {
    html: string
    directory: string
    resolution: ResearchVideoResolution
  },
  parentSignal: AbortSignal
): Promise<string> {
  parentSignal.throwIfAborted()
  verifyFilmPlayerHtml(html)
  assertVideoEncoderReady()
  const { width, height } = RESEARCH_VIDEO_EXPORT_OPTIONS[resolution]
  return withFilmBrowser(parentSignal, (browser) =>
    withFilmPlayer(
      browser,
      html,
      '16x9',
      parentSignal,
      async (page, { duration }, setupSignal) => {
        const signal = AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(researchVideoExportTimeout(resolution, duration))
        ])
        const audio: unknown = await waitForFilmStep(setupSignal, () =>
          page.evaluate(`(() => {
            const audio = window.VIDEO_ASSETS?.['mix.wav'];
            return typeof audio === 'string' && audio.length <= ${maxAudioLength} ? audio : null;
          })()`)
        )
        if (typeof audio !== 'string' || !audio.startsWith(wavPrefix))
          throw new Error('Invalid narration audio')
        const audioPath = join(directory, 'audio.wav')
        const outputPath = join(directory, 'video.mp4')
        await writeFile(audioPath, Buffer.from(audio.slice(wavPrefix.length), 'base64'), {
          flag: 'wx',
          signal
        })
        await exportResearchVideoMp4({
          renderer: {
            async capture(seconds, captureSignal) {
              await waitForFilmStep(captureSignal, () =>
                page.evaluate(`(() => {
                  window.__seek(${seconds});
                  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                })()`)
              )
              const frame = await waitForFilmStep(captureSignal, () =>
                page.screenshot({ type: 'png', scale: 'device' })
              )
              // PNG stores frame dimensions in its fixed IHDR header.
              if (
                frame.length < 24 ||
                frame.readUInt32BE(16) !== width ||
                frame.readUInt32BE(20) !== height
              )
                throw new Error('Film frame dimensions do not match the requested video resolution')
              return frame
            }
          },
          audioPath,
          outputPath,
          encoderPath,
          probePath,
          width,
          height,
          duration,
          signal
        })
        signal.throwIfAborted()
        return outputPath
      },
      width / filmStageSize('16x9').width
    )
  )
}
