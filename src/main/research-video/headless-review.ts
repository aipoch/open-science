import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Browser } from 'playwright-core'
import sharp from 'sharp'
import type { FilmVisualResult } from '@aipoch/research-film/contracts'
import {
  filmPlayerCsp,
  FilmDraftVisualError,
  filmStageSize,
  inspectFilmPlayer,
  readFilmStage,
  verifyFilmPlayerHtml,
  type FilmAspect
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
      ? `Headless Research explanation needs Chrome, Chromium, or Microsoft Edge. Install a browser or set ${browserVariable} to its executable path before starting Open Science.`
      : `The browser specified by ${browserVariable} is not executable. Use an absolute browser executable path and restart Open Science.`
  )
}

function browserEnvironment(): NodeJS.ProcessEnv {
  // The browser needs system paths and locale, but has no use for provider credentials or proxies.
  const systemVariable =
    /^(?:PATH|PATHEXT|SystemRoot|SystemDrive|WINDIR|OS|HOME|USER|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|TMPDIR|LANG|LC_\w+|XDG_RUNTIME_DIR)$/i
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => systemVariable.test(key)))
}

async function openReviewBrowser(): Promise<Browser> {
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
  const browser = await openReviewBrowser()
  await browser.close()
  signal.throwIfAborted()
}

async function checkFilmAspect(
  browser: Browser,
  html: string,
  aspect: FilmAspect,
  includeFrames: boolean,
  parentSignal: AbortSignal
): Promise<FilmVisualResult> {
  const setupSignal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
  const setup = <T>(work: () => Promise<T>): Promise<T> => waitForFilmStep(setupSignal, work)
  const viewport = filmStageSize(aspect)
  const url = `https://research-video.invalid/player?render&ar=${aspect}&job=${randomUUID()}`
  const context = await setup(() =>
    browser.newContext({
      viewport,
      offline: true,
      permissions: [],
      acceptDownloads: false,
      serviceWorkers: 'block'
    })
  )
  try {
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
    const reviewSignal = AbortSignal.any([parentSignal, AbortSignal.timeout(120_000)])
    return await inspectFilmPlayer({
      aspect,
      stage,
      includeFrames,
      check: () =>
        waitForFilmStep(reviewSignal, () =>
          page.evaluate('Promise.resolve().then(() => window.__checkFilm()).catch(() => null)')
        ),
      capture: async (time, scene) => {
        const sought = await waitForFilmStep(reviewSignal, () =>
          page.evaluate(
            `Promise.resolve().then(() => {
              window.__seek(${time});
              return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
            }).catch(() => false)`
          )
        )
        if (sought !== true)
          throw new FilmDraftVisualError('The player could not render the selected scene.', scene)
        const image = await waitForFilmStep(reviewSignal, () =>
          page.screenshot({ type: 'png', scale: 'css' })
        )
        const jpeg = await waitForFilmStep(reviewSignal, () =>
          sharp(image).resize(960, 540).jpeg({ quality: 78 }).toBuffer()
        )
        return jpeg.toString('base64')
      }
    })
  } finally {
    if (browser.isConnected()) await context.close()
  }
}

export async function checkHeadlessResearchFilmHtml(
  request: { htmlPath: string; includeFrames: boolean },
  signal: AbortSignal
): Promise<FilmVisualResult> {
  signal.throwIfAborted()
  const html = await readFile(request.htmlPath, { encoding: 'utf8', signal })
  verifyFilmPlayerHtml(html)
  const browser = await openReviewBrowser()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= browser.close())
  const onAbort = (): void => {
    void close().catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const portrait = await checkFilmAspect(browser, html, '9x16', false, signal)
    return portrait.issues.length
      ? portrait
      : await checkFilmAspect(browser, html, '16x9', request.includeFrames, signal)
  } finally {
    signal.removeEventListener('abort', onAbort)
    await close()
  }
}
