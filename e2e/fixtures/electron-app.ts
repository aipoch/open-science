import { expect, test as base } from '@playwright/test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  RuntimeResourceProfiler,
  type RuntimeProfileResult,
  type RuntimeResourceProfilerOptions
} from '../../scripts/performance/runtime-resource-profiler'
import { terminateProcessTree } from '../../src/main/process-tree'
import { createProjectDbClient } from '../../src/main/projects/prisma-client'
import { RendererFailureGate } from './renderer-failure-gate'

const APP_ROOT = resolve(process.cwd())
const FAKE_AGENT_PATH = resolve(APP_ROOT, 'e2e', 'fixtures', 'fake-opencode.mjs')
const FAKE_REMOTEIT_PATH = resolve(APP_ROOT, 'e2e', 'fixtures', 'fake-remoteit.cjs')
const FAKE_PROVIDER_NAME = 'Electron E2E provider'
type E2eWindowMode = 'hidden' | 'normal'

// Keep in sync with GitHubStarBadge. Workspace variant waits 5s, then opens a popover that can
// swallow the next pointer click (revision navigation, project menus) on macOS and Windows CI.
const STAR_NUDGE_LAST_SHOWN_STORAGE_KEY = 'open-science:github-star-nudge-last-shown-at'

const recordStarNudgeCooldown = (storageKey: string): void => {
  try {
    window.localStorage.setItem(storageKey, String(Date.now()))
  } catch {
    // Isolated source-preview documents and opaque origins deny localStorage.
  }
}

const suppressWorkspaceStarNudge = async (page: Pick<Page, 'evaluate'>): Promise<void> => {
  await page.evaluate(recordStarNudgeCooldown, STAR_NUDGE_LAST_SHOWN_STORAGE_KEY)
}

const electronLaunchTarget = (
  userDataRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { args: string[]; executablePath?: string } => {
  const executablePath = environment.OPEN_SCIENCE_E2E_EXECUTABLE
  return {
    args: [
      `--user-data-dir=${userDataRoot}`,
      ...(platform === 'linux' ? ['--password-store=basic'] : []),
      ...(executablePath ? [] : [APP_ROOT])
    ],
    ...(executablePath ? { executablePath } : {})
  }
}

type LaunchRoots = {
  fakeAgentBinRoot: string
  fakeRemoteItRoot: string
  fakeRemoteItState: string
  storageRoot: string
  userDataRoot: string
}

type ShortcutModifier = 'alt' | 'control' | 'meta' | 'shift'

type ElectronCleanupTarget = {
  close: () => Promise<void>
  forceClose: () => Promise<void>
}

type ElectronCleanupOptions = {
  forcedTimeoutMs: number
  gracefulTimeoutMs: number
}

const settlesWithin = async (promise: Promise<void>, timeoutMs: number): Promise<boolean> =>
  new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

const closeElectronApplicationForCleanup = async (
  target: ElectronCleanupTarget,
  { gracefulTimeoutMs, forcedTimeoutMs }: ElectronCleanupOptions
): Promise<void> => {
  const forceCloseWithinBudget = async (): Promise<void> => {
    if (await settlesWithin(target.forceClose(), forcedTimeoutMs)) return
    throw new Error(`Electron E2E forced close did not finish within ${forcedTimeoutMs}ms.`)
  }

  let closeError: unknown
  const closing = target.close().catch((error: unknown) => {
    closeError = error
  })
  if (await settlesWithin(closing, gracefulTimeoutMs)) {
    if (closeError === undefined) return
    await forceCloseWithinBudget()
    throw closeError
  }

  await forceCloseWithinBudget()
  if (closeError !== undefined) throw closeError
}

type ElectronApp = {
  readonly page: Page
  allowRendererConsoleError: (text: string) => void
  armDelegatedHandoffCleanupSabotage: (childName: string) => Promise<void>
  beginResourceProfile: (options?: RuntimeResourceProfilerOptions) => Promise<void>
  capturePersistedLocaleNativeQuitDialog: () => Promise<{
    buttons: string[]
    detail: string
    includesRendererCatalog: boolean
    message: string
  } | null>
  completeOnboarding: () => Promise<Page>
  configureFakeAgent: () => Promise<Page>
  createTestDirectory: (name: string) => Promise<string>
  enableFakeRemoteIt: () => Promise<Page>
  findOverlayIsVisible: () => Promise<boolean>
  launchSecondInstance: () => Promise<Page>
  mainWindowState: () => Promise<{ minimized: boolean; visible: boolean }>
  markResourceProfilePhase: (phase: string) => Promise<void>
  pressMainWindowShortcut: (key: string, modifiers: ShortcutModifier[]) => Promise<void>
  readFakeAgentPrompts: () => Promise<
    readonly Readonly<{ sessionId: string; role: 'main' | 'delegate'; prompt: string }>[]
  >
  requestMainWindowClose: () => Promise<void>
  restoreDelegatedHandoffCleanup: (childName: string) => Promise<void>
  emitPreviewContextMenuAtCssPoint: (point: { x: number; y: number }) => Promise<void>
  showMainWindow: () => Promise<void>
  restart: (options?: { resourceProfilePhase?: string }) => Promise<Page>
  restartWithCorruptHistoricalSessionFile: (projectId: string) => Promise<Page>
  sabotageDelegatedHandoffCleanup: (childName: string) => Promise<void>
  sampleResourceProfileNow: () => Promise<void>
  setMainWindowZoomFactor: (factor: number) => Promise<void>
  finishResourceProfile: () => Promise<RuntimeProfileResult>
}

const launchEnvironment = (
  storageRoot: string,
  fakeAgentBinRoot?: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  fakeRemoteItRoot?: string,
  windowMode: E2eWindowMode = 'hidden',
  sessionPerformanceTrace = false
): Record<string, string> => {
  const environment: Record<string, string> = {}

  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') environment[key] = value
  }

  environment.OPEN_SCIENCE_STORAGE_ROOT = storageRoot
  environment.OPEN_SCIENCE_E2E_STORAGE_ROOT = storageRoot
  environment.OPEN_SCIENCE_E2E_HANDOFF_CAPTURE_ROOT = join(storageRoot, 'e2e-handoff-captures')
  environment.OPEN_SCIENCE_E2E_WINDOW_MODE = windowMode
  if (sessionPerformanceTrace) environment.OPEN_SCIENCE_PERF_SESSION_TRACE = '1'
  if (fakeRemoteItRoot) {
    environment.OPEN_SCIENCE_FAKE_REMOTEIT_STATE = join(storageRoot, 'fake-remoteit-state.json')
    environment.OPEN_SCIENCE_REMOTEIT_BIN = process.execPath
  }
  if (fakeAgentBinRoot) {
    const inheritedPath = Object.entries(environment).find(
      ([key]) => key.toLowerCase() === 'path'
    )?.[1]
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === 'path') delete environment[key]
    }
    environment.OPEN_SCIENCE_AGENT_FRAMEWORK = 'opencode'
    environment.PATH = `${fakeAgentBinRoot}${delimiter}${inheritedPath ?? ''}`
  }
  return environment
}

const launchOpenScience = async (
  { storageRoot, userDataRoot, fakeAgentBinRoot }: LaunchRoots,
  fakeAgentEnabled: boolean,
  fakeRemoteItEnabled: boolean,
  fakeRemoteItRoot: string,
  windowMode: E2eWindowMode,
  sessionPerformanceTrace: boolean
): Promise<ElectronApplication> => {
  const application = await electron.launch({
    ...electronLaunchTarget(userDataRoot),
    cwd: fakeRemoteItEnabled ? fakeRemoteItRoot : APP_ROOT,
    env: launchEnvironment(
      storageRoot,
      fakeAgentEnabled ? fakeAgentBinRoot : undefined,
      process.env,
      fakeRemoteItEnabled ? fakeRemoteItRoot : undefined,
      windowMode,
      sessionPerformanceTrace
    )
  })

  if (process.platform === 'linux') {
    await application.evaluate(({ safeStorage }) => {
      // Linux CI has no desktop keyring. Keep its isolated test cipher, but make this
      // Playwright-controlled main process report a secure test backend so fake credentials can
      // exercise the production Settings path without adding a production security bypass.
      safeStorage.setUsePlainTextEncryption(true)
      Object.defineProperty(safeStorage, 'getSelectedStorageBackend', {
        configurable: true,
        value: () => 'gnome_libsecret'
      })
    })
  }

  return application
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const writeFakeAgentLauncher = async (binRoot: string): Promise<void> => {
  await mkdir(binRoot, { recursive: true })

  if (process.platform === 'win32') {
    await writeFile(
      join(binRoot, 'opencode.cmd'),
      `@echo off\r\n"${process.execPath}" "${FAKE_AGENT_PATH}" %*\r\n`,
      'utf8'
    )
    return
  }

  const launcher = join(binRoot, 'opencode')
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_AGENT_PATH)} "$@"\n`,
    'utf8'
  )
  await chmod(launcher, 0o755)
}

const writeFakeRemoteItCommands = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true })
  const source = `require(${JSON.stringify(FAKE_REMOTEIT_PATH)})\n`
  await Promise.all(
    ['exec-gql', 'service', 'status', 'version'].map((command) =>
      writeFile(join(root, command), source, 'utf8')
    )
  )
}

const makeTreeWritable = async (root: string): Promise<void> => {
  await chmod(root, 0o700).catch(() => undefined)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) await makeTreeWritable(path)
      else if (!entry.isSymbolicLink()) await chmod(path, 0o600).catch(() => undefined)
    })
  )
}

const waitForRendererReady = async (page: Page): Promise<void> => {
  await page.waitForLoadState('domcontentloaded')
  // A fresh Windows profile can spend longer than the general assertion budget applying the real
  // schema manifest under runner I/O contention. Keep the startup gate aligned with settings load.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const bridge = globalThis as unknown as {
            api: { databaseStartup: { getState: () => Promise<{ phase: string }> } }
          }
          return (await bridge.api.databaseStartup.getState()).phase
        }),
      { timeout: 60_000 }
    )
    .toBe('ready')
  await page.getByText('Loading settings...').waitFor({ state: 'hidden', timeout: 60_000 })
}

const applyHiddenWindowPresentation = async (
  page: Page,
  windowMode: E2eWindowMode
): Promise<void> => {
  // Hidden BrowserWindows do not produce animation frames reliably, so make
  // presentation buffers commit immediately without changing normal-window tests.
  if (windowMode === 'hidden') await page.emulateMedia({ reducedMotion: 'reduce' })
}

const openMainWindow = async (
  application: ElectronApplication,
  rendererFailures: RendererFailureGate,
  windowMode: E2eWindowMode
): Promise<Page> => {
  const page = await application.firstWindow()
  await applyHiddenWindowPresentation(page, windowMode)
  await rendererFailures.observe(page)
  await waitForRendererReady(page)
  // Writing the cooldown after first paint does not cancel a timer GitHubStarBadge already
  // scheduled. Reload so the workspace variant remounts with the cooldown already set.
  await suppressWorkspaceStarNudge(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await applyHiddenWindowPresentation(page, windowMode)
  await waitForRendererReady(page)
  return page
}

class ElectronAppHarness implements ElectronApp {
  private application: ElectronApplication | undefined
  private currentPage: Page | undefined
  private fakeAgentEnabled = false
  private fakeRemoteItEnabled = false
  private readonly rendererFailures = new RendererFailureGate()
  private resourceProfiler: RuntimeResourceProfiler | undefined
  private readonly sabotagedDelegatedHandoffs = new Map<string, string>()

  private constructor(
    private readonly testRoot: string,
    private readonly roots: LaunchRoots,
    private readonly windowMode: E2eWindowMode
  ) {}

  static async create(windowMode: E2eWindowMode): Promise<ElectronAppHarness> {
    const testRoot = await mkdtemp(join(tmpdir(), 'open-science-electron-e2e-'))
    const harness = new ElectronAppHarness(
      testRoot,
      {
        fakeAgentBinRoot: join(testRoot, 'fake-agent-bin'),
        fakeRemoteItRoot: join(testRoot, 'fake-remoteit'),
        fakeRemoteItState: join(testRoot, 'storage', 'fake-remoteit-state.json'),
        storageRoot: join(testRoot, 'storage'),
        userDataRoot: join(testRoot, 'electron-profile')
      },
      windowMode
    )
    try {
      await mkdir(harness.roots.storageRoot, { recursive: true })
      await writeFile(harness.roots.fakeRemoteItState, JSON.stringify({ services: [] }), 'utf8')
      await writeFakeAgentLauncher(harness.roots.fakeAgentBinRoot)
      await writeFakeRemoteItCommands(harness.roots.fakeRemoteItRoot)
      await harness.launch()
      return harness
    } catch (error) {
      await harness.dispose().catch(() => undefined)
      throw error
    }
  }

  get page(): Page {
    if (!this.currentPage) throw new Error('Electron application is not running.')
    return this.currentPage
  }

  allowRendererConsoleError(text: string): void {
    this.rendererFailures.allowConsoleError(text)
  }

  async beginResourceProfile(options: RuntimeResourceProfilerOptions = {}): Promise<void> {
    if (this.resourceProfiler) throw new Error('Runtime resource profiling is already active.')
    const profileDataRoot = join(this.testRoot, 'profile-data')
    await mkdir(profileDataRoot, { recursive: true })
    await this.close()
    const settingsPath = join(this.roots.storageRoot, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    settings.dataRoot = profileDataRoot
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await this.launch()
    const dataRoot = await this.page.evaluate(
      async () => (await window.api.storage.getInfo()).dataRoot
    )
    if (dataRoot !== profileDataRoot) {
      throw new Error('Runtime resource profile did not activate its isolated data root.')
    }
    const profiler = new RuntimeResourceProfiler({
      ...options,
      dataRoot,
      storageRoot: this.roots.storageRoot
    })
    this.resourceProfiler = profiler
    await profiler.attach(this.runningApplication)
  }

  async capturePersistedLocaleNativeQuitDialog(): Promise<{
    buttons: string[]
    detail: string
    includesRendererCatalog: boolean
    message: string
  } | null> {
    return this.runningApplication.evaluate(async ({ app, dialog }) => {
      const { readFileSync, readdirSync } = process.getBuiltinModule('node:fs')
      const { createRequire } = process.getBuiltinModule('node:module')
      const { join } = process.getBuiltinModule('node:path')
      const appRoot = app.getAppPath()
      const mainRoot = join(appRoot, 'out', 'main')
      const chunk = (prefix: string): string => {
        const name = readdirSync(mainRoot).find(
          (candidate) => candidate.startsWith(`${prefix}-`) && candidate.endsWith('.js')
        )
        if (!name) throw new Error(`Built Electron chunk ${prefix} was not found.`)
        return join(mainRoot, name)
      }
      const requireFromApp = createRequire(join(appRoot, 'package.json'))
      const nativeChunk = chunk('main-process-messages')
      const nativeSource = readFileSync(nativeChunk, 'utf8')
      const ownerModule = requireFromApp(chunk('owner')) as {
        LocalePreferenceOwner: new (
          systemLanguageTags: readonly string[],
          repository: { setLocalePreference: (locale: string) => Promise<void> },
          initialPreference: string
        ) => {
          t: (key: string, options?: Record<string, string | number>) => string
        }
      }
      const close = requireFromApp(chunk('window-close-confirm')) as {
        createElectronCloseConfirm: (
          getWindow: () => undefined,
          preferences: {
            get: () => Promise<undefined>
            set: () => Promise<void>
          },
          translate: (key: string, options?: Record<string, string | number>) => string
        ) => (
          variant: 'quit',
          sessions: Array<{ projectId: string; sessionId: string; kind: 'agent' }>
        ) => Promise<string>
      }
      const storageRoot = process.env.OPEN_SCIENCE_STORAGE_ROOT
      if (!storageRoot) throw new Error('Electron E2E storage root is unavailable.')
      const settings = JSON.parse(readFileSync(join(storageRoot, 'settings.json'), 'utf8')) as {
        localePreference?: string
      }
      if (!settings.localePreference || settings.localePreference === 'system') {
        return null
      }
      const localeOwner = new ownerModule.LocalePreferenceOwner(
        ['en-US'],
        { setLocalePreference: async () => undefined },
        settings.localePreference
      )
      let captured: { buttons?: string[]; detail?: string; message?: string } | undefined
      const descriptor = Object.getOwnPropertyDescriptor(dialog, 'showMessageBox')
      Object.defineProperty(dialog, 'showMessageBox', {
        configurable: true,
        value: async (...args: unknown[]) => {
          captured = args.at(-1) as typeof captured
          return { checkboxChecked: false, response: 0 }
        }
      })

      try {
        const confirm = close.createElectronCloseConfirm(
          () => undefined,
          { get: async () => undefined, set: async () => undefined },
          (key, options) => localeOwner.t(key, options)
        )
        await confirm('quit', [{ projectId: 'e2e', sessionId: 'e2e', kind: 'agent' }])
      } finally {
        if (descriptor) Object.defineProperty(dialog, 'showMessageBox', descriptor)
        else Reflect.deleteProperty(dialog, 'showMessageBox')
      }

      if (!captured?.buttons || !captured.detail || !captured.message) {
        throw new Error('Native quit dialog options were not captured.')
      }
      return {
        buttons: captured.buttons,
        detail: captured.detail,
        includesRendererCatalog: [
          'Настройки',
          'This directory does not exist or is not a directory'
        ].some((sentinel) => nativeSource.includes(sentinel)),
        message: captured.message
      }
    })
  }

  async markResourceProfilePhase(phase: string): Promise<void> {
    if (!this.resourceProfiler) throw new Error('Runtime resource profiling is not active.')
    this.resourceProfiler.markPhase(phase)
    await this.resourceProfiler.sampleNow()
  }

  async sampleResourceProfileNow(): Promise<void> {
    if (!this.resourceProfiler) throw new Error('Runtime resource profiling is not active.')
    await this.resourceProfiler.sampleNow()
  }

  async finishResourceProfile(): Promise<RuntimeProfileResult> {
    const profiler = this.resourceProfiler
    if (!profiler) throw new Error('Runtime resource profiling is not active.')
    this.resourceProfiler = undefined
    profiler.detach()
    return profiler.finish()
  }

  async completeOnboarding(): Promise<Page> {
    await this.page.evaluate(async () => {
      const bridge = globalThis as unknown as {
        api: { settings: { markOnboardingComplete: () => Promise<unknown> } }
      }
      await bridge.api.settings.markOnboardingComplete()
    })
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    return this.page
  }

  async configureFakeAgent(): Promise<Page> {
    await this.page.evaluate(async (providerName) => {
      const bridge = globalThis as unknown as {
        api: {
          settings: {
            setActiveProvider: (request: { id: string; model: string }) => Promise<unknown>
            setAgentFramework: (request: { id: 'opencode' }) => Promise<unknown>
            upsertProvider: (request: {
              apiEndpoints: ['openai']
              baseUrl: string
              key: string
              model: string
              name: string
              supportsImageInput: true
              type: 'custom'
            }) => Promise<{ providers: Array<{ id: string; name: string }> }>
          }
        }
      }
      const snapshot = await bridge.api.settings.upsertProvider({
        type: 'custom',
        name: providerName,
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'e2e-model',
        key: 'e2e-key',
        supportsImageInput: true
      })
      const provider = snapshot.providers.find((item) => item.name === providerName)
      if (!provider) throw new Error('The E2E provider was not persisted.')

      await bridge.api.settings.setActiveProvider({ id: provider.id, model: 'e2e-model' })
      await bridge.api.settings.setAgentFramework({ id: 'opencode' })
    }, FAKE_PROVIDER_NAME)

    this.fakeAgentEnabled = true
    await this.close()
    const settingsPath = join(this.roots.storageRoot, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    settings.opencodePath = join(
      this.roots.fakeAgentBinRoot,
      process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
    )
    settings.opencodeVersion = '1.0.0'
    // Specs assert English copy. Pin the locale so the host language can't leak in — Main
    // resolves a 'system' preference from the OS language list, ignoring Chromium's --lang.
    settings.localePreference = 'en'
    if (process.platform === 'win32') {
      // Inherit would spawn a second fake Agent just to generate the Session title. That extra
      // process and its queued/running/terminal Session writes overlap the first user turn on
      // Windows CI and leave the conversation stuck on Thinking.
      settings.sessionDetailsModel = { mode: 'disabled' }
    }
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await this.launch()
    return this.page
  }

  async createTestDirectory(name: string): Promise<string> {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid E2E directory name: ${name}`)
    const path = join(this.testRoot, name)
    await mkdir(path, { recursive: true })
    return path
  }

  async enableFakeRemoteIt(): Promise<Page> {
    this.fakeRemoteItEnabled = true
    return this.restart()
  }

  async findOverlayIsVisible(): Promise<boolean> {
    return this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) return false

      return mainWindow.contentView.children.some((view) => {
        const bounds = view.getBounds()
        return bounds.width > 0 && bounds.height > 0
      })
    })
  }

  async mainWindowState(): Promise<{ minimized: boolean; visible: boolean }> {
    return this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')

      return { minimized: mainWindow.isMinimized(), visible: mainWindow.isVisible() }
    })
  }

  async showMainWindow(): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      mainWindow.show()
    })
    await expect.poll(() => this.mainWindowState()).toMatchObject({ visible: true })
  }

  async setMainWindowZoomFactor(factor: number): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, nextFactor) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      mainWindow.webContents.setZoomFactor(nextFactor)
    }, factor)
  }

  async launchSecondInstance(): Promise<Page> {
    const { appPath, executable } = await this.runningApplication.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      executable: process.execPath
    }))
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(
        executable,
        [
          `--user-data-dir=${this.roots.userDataRoot}`,
          ...(process.env.OPEN_SCIENCE_E2E_EXECUTABLE ? [] : [appPath])
        ],
        {
          cwd: APP_ROOT,
          env: launchEnvironment(
            this.roots.storageRoot,
            this.fakeAgentEnabled ? this.roots.fakeAgentBinRoot : undefined,
            process.env,
            this.fakeRemoteItEnabled ? this.roots.fakeRemoteItRoot : undefined,
            this.windowMode
          ),
          stdio: 'ignore'
        }
      )
      child.once('error', rejectLaunch)
      child.once('exit', (code, signal) => {
        if (code === 0) resolveLaunch()
        else rejectLaunch(new Error(`Second Electron instance exited with ${code ?? signal}.`))
      })
    })
    return this.page
  }

  async pressMainWindowShortcut(key: string, modifiers: ShortcutModifier[]): Promise<void> {
    await this.runningApplication.evaluate(
      ({ BrowserWindow }, input) => {
        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (!mainWindow) throw new Error('Open Science main window was not found.')

        mainWindow.webContents.focus()
        mainWindow.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: input.key,
          modifiers: input.modifiers
        })
        mainWindow.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: input.key,
          modifiers: input.modifiers
        })
      },
      { key, modifiers }
    )
  }

  async requestMainWindowClose(): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      mainWindow.close()
    })
  }

  async emitPreviewContextMenuAtCssPoint(point: { x: number; y: number }): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, cssPoint) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      const { webContents } = mainWindow
      const frame = webContents.mainFrame.framesInSubtree.find(
        (candidate) =>
          candidate !== webContents.mainFrame && candidate.url.startsWith('open-science-preview:')
      )
      if (!frame) throw new Error('Managed HTML preview frame was not found.')
      const zoomFactor = webContents.getZoomFactor()
      // Playwright injects CSS coordinates; Electron's native context-menu event reports DIPs.
      const contextMenuPoint = {
        x: Math.round(cssPoint.x * zoomFactor),
        y: Math.round(cssPoint.y * zoomFactor)
      }
      webContents.emit(
        'context-menu',
        {} as Electron.Event,
        {
          ...contextMenuPoint,
          frame,
          isEditable: false,
          formControlType: 'none'
        } as Electron.ContextMenuParams
      )
    }, point)
  }

  async readFakeAgentPrompts(): Promise<
    readonly Readonly<{ sessionId: string; role: 'main' | 'delegate'; prompt: string }>[]
  > {
    const path = join(this.roots.storageRoot, 'e2e-handoff-captures', 'provider-prompts.jsonl')
    const content = await readFile(path, 'utf8').catch(() => '')
    return content
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { sessionId: string; role: 'main' | 'delegate'; prompt: string }
      )
  }

  async armDelegatedHandoffCleanupSabotage(childName: string): Promise<void> {
    const captureRoot = join(this.roots.storageRoot, 'e2e-handoff-captures')
    await mkdir(captureRoot, { recursive: true })
    await writeFile(
      join(captureRoot, `${Buffer.from(childName).toString('base64url')}.sabotage`),
      '',
      'utf8'
    )
  }

  async sabotageDelegatedHandoffCleanup(childName: string): Promise<void> {
    const dataRoot = await this.page.evaluate(
      async () => (await window.api.storage.getInfo()).dataRoot
    )
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const target = await this.findDelegatedHandoff(dataRoot, childName)
      if (target) {
        await rm(target, { force: true })
        await mkdir(target)
        this.sabotagedDelegatedHandoffs.set(childName, target)
        return
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
    const captureRoot = join(this.roots.storageRoot, 'e2e-handoff-captures')
    const captures = await readdir(captureRoot).catch(() => [])
    throw new Error(
      `Timed out validating the sabotaged handoff for ${childName} under ${dataRoot}; captures: ${captures.join(', ') || 'none'}.`
    )
  }

  async restoreDelegatedHandoffCleanup(childName: string): Promise<void> {
    const target = this.sabotagedDelegatedHandoffs.get(childName)
    if (!target) throw new Error(`No sabotaged delegated handoff exists for ${childName}.`)
    await rm(target, { force: true, recursive: true })
    this.sabotagedDelegatedHandoffs.delete(childName)
  }

  async restart(options: { resourceProfilePhase?: string } = {}): Promise<Page> {
    await this.close()
    if (options.resourceProfilePhase) {
      if (!this.resourceProfiler) throw new Error('Runtime resource profiling is not active.')
      this.resourceProfiler.markPhase(options.resourceProfilePhase)
    }
    await this.launch()
    return this.page
  }

  async restartWithCorruptHistoricalSessionFile(projectId: string): Promise<Page> {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      throw new Error(`Invalid E2E project id: ${projectId}`)
    }
    await this.close()
    const projectSessionsRoot = join(this.roots.storageRoot, 'sessions', projectId)
    await mkdir(projectSessionsRoot, { recursive: true })
    await writeFile(join(projectSessionsRoot, 'corrupt-e2e-session.json'), '{invalid json', 'utf8')

    // Exercise the historical-JSON backfill path. A healthy projection intentionally avoids
    // inventorying every Session JSON on startup, so an unindexed out-of-band file alone should not
    // trigger a scan.
    const client = createProjectDbClient(this.roots.storageRoot)
    try {
      await client.sessionProjectionState.deleteMany()
    } finally {
      await client.$disconnect()
    }

    await this.launch()
    return this.page
  }

  async dispose(): Promise<void> {
    this.resourceProfiler?.abort()
    this.resourceProfiler = undefined
    await this.closeForCleanup().catch(() => undefined)
    await makeTreeWritable(this.testRoot)
    await rm(this.testRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
    this.rendererFailures.assertNoFailures()
  }

  private async launch(): Promise<void> {
    this.application = await launchOpenScience(
      this.roots,
      this.fakeAgentEnabled,
      this.fakeRemoteItEnabled,
      this.roots.fakeRemoteItRoot,
      this.windowMode,
      this.resourceProfiler !== undefined
    )
    await this.resourceProfiler?.attach(this.application)
    this.currentPage = await openMainWindow(
      this.application,
      this.rendererFailures,
      this.windowMode
    )
  }

  private get runningApplication(): ElectronApplication {
    if (!this.application) throw new Error('Electron application is not running.')
    return this.application
  }

  private async findDelegatedHandoff(
    dataRoot: string,
    childName: string
  ): Promise<string | undefined> {
    const attemptId = await this.page.evaluate(
      async ({ expectedChildName }) => {
        const loaded = await window.api.sessions.loadAll()
        for (const session of loaded.sessions) {
          const frame = session.conversationGraph?.frames.find(
            (candidate) => candidate.delegateName === expectedChildName
          )
          const attempt = session.runtimeContext?.delegatedWork?.records
            .find((record) => record.agentFrameId === frame?.id)
            ?.attempts.at(-1)
          if (attempt?.status === 'running') return attempt.id
        }
        return undefined
      },
      { expectedChildName: childName }
    )
    if (!attemptId) return undefined

    const capturePath = join(
      this.roots.storageRoot,
      'e2e-handoff-captures',
      `${Buffer.from(childName).toString('base64url')}.json`
    )
    const captured = await readFile(capturePath, 'utf8')
      .then((content) => JSON.parse(content) as { executionId?: string; handoffPath?: string })
      .catch(() => undefined)
    if (!captured?.handoffPath) return undefined
    const handoffPath = resolve(captured.handoffPath)
    const artifactRoot = resolve(dataRoot, 'artifacts')
    const artifactRelative = relative(artifactRoot, handoffPath)
    if (
      !isAbsolute(handoffPath) ||
      artifactRelative === '..' ||
      artifactRelative.startsWith(`..${sep}`) ||
      isAbsolute(artifactRelative)
    ) {
      throw new Error(`Captured delegated handoff escaped the E2E artifact root: ${handoffPath}`)
    }
    if (captured.executionId !== attemptId) {
      throw new Error(
        `Captured delegated handoff execution ${captured.executionId ?? 'missing'} did not match durable Attempt ${attemptId}.`
      )
    }
    return handoffPath
  }

  private async close(): Promise<void> {
    if (!this.application) return

    const application = this.application
    this.resourceProfiler?.detach(application)
    this.application = undefined
    this.currentPage = undefined
    await application.close()
  }

  private async closeForCleanup(): Promise<void> {
    if (!this.application) return

    const application = this.application
    this.resourceProfiler?.detach(application)
    this.application = undefined
    this.currentPage = undefined
    await closeElectronApplicationForCleanup(
      {
        close: () => application.close(),
        forceClose: async () => {
          const result = await terminateProcessTree(application.process())
          if (!result.reaped)
            throw new Error('Electron E2E forced close did not reap the process tree.')
        }
      },
      { gracefulTimeoutMs: 10_000, forcedTimeoutMs: 10_000 }
    )
  }
}

const test = base.extend<{ app: ElectronApp; windowMode: E2eWindowMode }>({
  windowMode: ['hidden', { option: true }],
  // Playwright fixture callbacks require an object pattern even when no base fixture is needed.
  app: async ({ windowMode }, install) => {
    const app = await ElectronAppHarness.create(windowMode)

    try {
      await install(app)
    } finally {
      await app.dispose()
    }
  }
})

export {
  closeElectronApplicationForCleanup,
  electronLaunchTarget,
  launchEnvironment,
  STAR_NUDGE_LAST_SHOWN_STORAGE_KEY,
  suppressWorkspaceStarNudge,
  test
}
export type { ElectronApp }
