import { expect, test as base, type TestInfo } from '@playwright/test'
import { spawn } from 'node:child_process'
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type JSHandle,
  type Page
} from 'playwright'
import {
  RuntimeResourceProfiler,
  type RuntimeProfileResult,
  type RuntimeResourceProfilerOptions
} from '../../scripts/performance/runtime-resource-profiler'
import { terminateProcessTree } from '../../src/main/process-tree'
import {
  readProcessTable,
  readProcessTree,
  selectProcessTree
} from '../../scripts/performance/process-snapshot'
import { createProjectDbClient } from '../../src/main/projects/prisma-client'
import { RendererFailureGate } from './renderer-failure-gate'
import type { ConversationSkillImportApprovalRequest } from '../../src/shared/settings'
import type { UpdateStatus } from '../../src/shared/update'
import { prepareBrandStorageFixture } from './brand-storage-data'
import { captureNativeQuitDialog } from './native-quit-dialog'
import type { PackageOperationSnapshot } from '../../src/shared/session-package'
import { createSessionFile, type PersistedChatSession } from '../../src/shared/session-persistence'

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
      ...(platform === 'darwin' && !executablePath
        ? [
            '--use-mock-keychain',
            '--require',
            resolve(APP_ROOT, 'e2e/fixtures/mock-credential-identity.cjs')
          ]
        : []),
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

const observeElectronFlushDiagnostics = async (
  application: Pick<ElectronApplication, 'process' | 'evaluate'>,
  page: Pick<Page, 'evaluate'>,
  record: (line: string) => void
): Promise<() => void> => {
  const prefix = 'E2E_FLUSH '
  const unavailable = (status: string): void =>
    record(JSON.stringify({ timestamp: Date.now(), requestId: '', status }))
  const stdout = application.process().stdout
  if (!stdout) {
    unavailable('stdout-unavailable')
    return () => undefined
  }
  const reader = createInterface({ input: stdout })
  reader.on('line', (line) => {
    if (line.startsWith(prefix)) record(line.slice(prefix.length))
  })
  reader.on('error', () => unavailable('stdout-error'))
  try {
    // Native stdout remains observable after Playwright disconnects the main inspector.
    await application.evaluate(({ BrowserWindow, ipcMain }, prefix) => {
      // The test-owned pipe can close while Electron is still stopping.
      process.stdout.on('error', () => undefined)
      const write = (line: string): void => {
        try {
          process.stdout.write(line + '\n')
        } catch {
          /* Diagnostics must not interrupt IPC. */
        }
      }
      ipcMain.on('sessions:flush-response', (_event, response) => {
        const { requestId, status } = response ?? {}
        if (typeof requestId === 'string' && ['completed', 'conflict', 'failed'].includes(status)) {
          write(prefix + JSON.stringify({ timestamp: Date.now(), requestId, status }))
        }
      })
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.on('console-message', ({ message }) => {
          if (message.startsWith(prefix)) write(message)
        })
      }
    }, prefix)
    await page.evaluate((prefix) => {
      window.api.sessions.onFlushRequest?.(({ requestId }) => {
        console.info(
          prefix + JSON.stringify({ timestamp: Date.now(), requestId, status: 'renderer-received' })
        )
      })
    }, prefix)
  } catch {
    unavailable('observer-installation-failed')
  }
  return () => {
    reader.close()
    // readline pauses its input on close; preserve other consumers of Playwright's shared pipe.
    if (stdout.listenerCount('data') > 0) stdout.resume()
  }
}

// Test-owned restart recovery: choose the existing Retry action once, and only
// after the exact flush that cancelled shutdown has acknowledged a successful save.
const installRestartPersistenceRetry = async (
  application: Pick<ElectronApplication, 'evaluate'>,
  windowId: number,
  timeoutMs: number
): Promise<void> => {
  await application.evaluate(
    ({ app, BrowserWindow, ipcMain }, { windowId, timeoutMs }) => {
      const window = BrowserWindow.fromId(windowId)
      if (!window) throw new Error('Electron E2E restart window is unavailable.')
      const contents = window.webContents
      const originalSend = contents.send
      const sendDescriptor = Object.getOwnPropertyDescriptor(contents, 'send')
      let requestId: string | undefined
      let status: string | undefined
      let recovering = false
      let settle: ((status: string) => void) | undefined
      const responseChannel = 'sessions:flush-response'
      const onResponse = (
        event: Electron.IpcMainEvent,
        response: { requestId?: string; status?: string }
      ): void => {
        if (event.sender !== contents || !requestId || response?.requestId !== requestId) return
        if (!['completed', 'conflict', 'failed'].includes(response.status ?? '')) return
        status = response.status
        settle?.(status!)
      }
      const restore = (): void => {
        if (sendDescriptor) Object.defineProperty(contents, 'send', sendDescriptor)
        else Reflect.deleteProperty(contents, 'send')
        ipcMain.removeListener(responseChannel, onResponse)
        app.removeListener('will-quit', restore)
      }
      ipcMain.on(responseChannel, onResponse)
      app.once('will-quit', restore)
      Object.defineProperty(contents, 'send', {
        configurable: true,
        value: (channel: string, ...args: unknown[]) => {
          const payload = args[0] as { requestId?: string; variant?: string } | undefined
          if (channel === 'sessions:flush-request' && !recovering) {
            requestId = payload?.requestId
            status = undefined
          }
          if (
            channel === 'window:close-confirm-request' &&
            payload?.variant === 'persistence-failed' &&
            payload.requestId &&
            requestId &&
            !recovering
          ) {
            recovering = true
            const confirmationId = payload.requestId
            const answer = (response: { ack: true } | { choice: 'retry' | 'cancel' }): void => {
              ipcMain.emit(
                'window:close-confirm-response',
                { sender: contents },
                {
                  requestId: confirmationId,
                  ...response
                }
              )
            }
            // Act as the test user through the existing confirmation protocol. Never forge a
            // successful flush or a force-quit choice; the retry runs both production gates again.
            answer({ ack: true })
            void (async () => {
              const result =
                status ??
                (await new Promise<string>((resolve) => {
                  const timer = setTimeout(() => resolve('timeout'), timeoutMs)
                  settle = (value) => {
                    clearTimeout(timer)
                    resolve(value)
                  }
                }))
              settle = undefined
              restore()
              answer({ choice: result === 'completed' ? 'retry' : 'cancel' })
            })()
            return
          }
          return originalSend.call(contents, channel, ...args)
        }
      })
    },
    { windowId, timeoutMs }
  )
}

type ElectronCleanupTarget = {
  close: () => Promise<void>
  forceClose: () => Promise<void>
}

type ElectronCleanupOptions = {
  forcedTimeoutMs: number
  gracefulTimeoutMs: number
  requireGraceful?: boolean
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

// Allow platform-specific shutdown latency while keeping each cleanup phase bounded.
const CLEANUP_GRACEFUL_TIMEOUT_MS =
  process.platform === 'win32' ? 30_000 : process.platform === 'darwin' ? 20_000 : 10_000
const CLEANUP_FORCED_TIMEOUT_MS =
  process.platform === 'win32' ? 30_000 : process.platform === 'darwin' ? 20_000 : 10_000

const closeElectronApplicationForCleanup = async (
  target: ElectronCleanupTarget,
  { gracefulTimeoutMs, forcedTimeoutMs, requireGraceful = false }: ElectronCleanupOptions
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
  if (requireGraceful) {
    throw new Error(`Electron E2E graceful close did not finish within ${gracefulTimeoutMs}ms.`)
  }
}

type BrandState = {
  name: string
  packaged: boolean
  profile: string
  logs: string
  title: string
  menus: string[]
}
type ElectronApp = {
  captureBrandState: () => Promise<BrandState>
  restartWithBrandFixture: (
    mode: 'legacy' | 'legacy-config' | 'custom' | 'onboarding'
  ) => Promise<Page>

  readonly page: Page
  openAdditionalRenderer: () => Promise<Page>
  authenticatedWebUrl: () => Promise<string>
  allowRendererConsoleError: (text: string) => void
  captureMainLog: (name: string) => Promise<string>
  armDelegatedHandoffCleanupSabotage: (childName: string) => Promise<void>
  beginResourceProfile: (options?: RuntimeResourceProfilerOptions) => Promise<void>
  capturePersistedLocaleNativeQuitDialog: () => Promise<{
    buttons: string[]
    detail: string
    includesRendererCatalog: boolean
    message: string
  } | null>
  completeOnboarding: () => Promise<Page>
  routeMarketplaceRequests: (origin: string) => Promise<void>
  configureFileBrowserFixture: () => Promise<void>
  configureFakeAgent: () => Promise<Page>
  createTestDirectory: (name: string) => Promise<string>
  configureSessionPackageDialogs: (options?: { availableBytes?: number }) => Promise<string>
  restartWithPackage: (path: string) => Promise<Page>
  emitPackageFileOpen: (path: string) => Promise<void>
  emitSessionPackageProgress: (snapshot: PackageOperationSnapshot) => Promise<void>
  emitSkillImportApprovalRequest: (request: ConversationSkillImportApprovalRequest) => Promise<void>
  emitUpdateStatus: (status: UpdateStatus) => Promise<void>
  enableFakeRemoteIt: () => Promise<Page>
  findOverlayIsVisible: () => Promise<boolean>
  launchSecondInstance: () => Promise<Page>
  mainWindowState: () => Promise<{ minimized: boolean; visible: boolean }>
  trustSourcePreviewCertificate: (certificate: string) => Promise<void>
  setDefaultSessionCookie: (url: string) => Promise<void>
  readClipboardText: () => Promise<string>
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
  restartAfterCrash: (options?: { force?: boolean }) => Promise<Page>
  restartWithCorruptHistoricalSessionFile: (projectId: string) => Promise<Page>
  restartWithSessionFixture: (session: PersistedChatSession) => Promise<Page>
  sabotageDelegatedHandoffCleanup: (childName: string) => Promise<void>
  recordResourceTiming: (name: string, durationMs: number) => void
  captureResourceTimings: (prefix?: string) => Promise<void>
  sampleResourceProfileNow: () => Promise<void>
  setMainWindowSize: (width: number, height: number) => Promise<void>
  auditSourceAttachments: () => Promise<JSHandle<boolean[]>>
  pressSourcePreviewShortcut: (
    url: string,
    key: string,
    modifiers?: ShortcutModifier[]
  ) => Promise<void>
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

  environment.OPEN_SCIENCE_CONFIG_ROOT = storageRoot
  environment.OPEN_SCIENCE_USER_DATA = join(dirname(storageRoot), 'electron-profile')
  environment.OPEN_SCIENCE_STORAGE_ROOT = storageRoot
  environment.OPEN_SCIENCE_E2E_STORAGE_ROOT = storageRoot
  environment.OPEN_SCIENCE_E2E_HANDOFF_CAPTURE_ROOT = join(storageRoot, 'e2e-handoff-captures')
  environment.OPEN_SCIENCE_E2E_WINDOW_MODE = windowMode
  if (process.platform === 'win32' && environment.OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS) {
    // The production runner caches resolved tools under LocalAppData. Keep the controlled process
    // fixture isolated from any micromamba selected by an ordinary Open-Science session.
    environment.LOCALAPPDATA = join(storageRoot, 'local-app-data')
  }
  if (sessionPerformanceTrace) environment.OPEN_SCIENCE_PERF_SESSION_TRACE = '1'
  if (fakeRemoteItRoot) {
    environment.OPEN_SCIENCE_FAKE_REMOTEIT_STATE = join(
      dirname(storageRoot),
      'fake-remoteit-state.json'
    )
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
  sessionPerformanceTrace: boolean,
  packagePath?: string
): Promise<ElectronApplication> => {
  const application = await electron.launch({
    ...electronLaunchTarget(userDataRoot),
    args: [...electronLaunchTarget(userDataRoot).args, ...(packagePath ? [packagePath] : [])],
    cwd: fakeRemoteItEnabled ? fakeRemoteItRoot : APP_ROOT,
    env: {
      ...launchEnvironment(
        storageRoot,
        fakeAgentEnabled ? fakeAgentBinRoot : undefined,
        process.env,
        fakeRemoteItEnabled ? fakeRemoteItRoot : undefined,
        windowMode,
        sessionPerformanceTrace
      ),
      OPEN_SCIENCE_CONFIG_ROOT: storageRoot,
      OPEN_SCIENCE_USER_DATA: userDataRoot
    }
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

const removeTreeForCleanup = async (root: string): Promise<void> => {
  // Keep retries outside recursive rm so they cannot multiply with directory depth.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { force: true, maxRetries: 0, recursive: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        !['EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EPERM'].includes(code ?? '') ||
        attempt === 4
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
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
  const deadline = performance.now() + (process.platform === 'win32' ? 180_000 : 90_000)
  const remainingTimeout = (): number => Math.max(1, deadline - performance.now())
  await page.waitForLoadState('domcontentloaded', { timeout: remainingTimeout() })
  // Hosted Windows spent 89s applying the real schema before application composition began.
  // Keep readiness bounded and share its budget with settings; the fixture owns startup time
  // independently of the test body's assertion budget.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const bridge = globalThis as unknown as {
            api: { databaseStartup: { getState: () => Promise<{ phase: string }> } }
          }
          // Preserve startup diagnostics when a migration blocks before the journey can begin.
          return await bridge.api.databaseStartup.getState()
        }),
      { timeout: remainingTimeout() }
    )
    .toMatchObject({ phase: 'ready' })
  await page
    .getByTestId('settings-startup-loading')
    .waitFor({ state: 'hidden', timeout: remainingTimeout() })
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
  windowMode: E2eWindowMode,
  onFirstReady?: (page: Page) => Promise<void>
): Promise<Page> => {
  const page = await application.firstWindow()
  await applyHiddenWindowPresentation(page, windowMode)
  await rendererFailures.observe(page)
  await waitForRendererReady(page)
  await onFirstReady?.(page)
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
  private mainLogDirectory: string | undefined
  private flushTimeline = ''
  private stopFlushDiagnostics: (() => void) | undefined
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

  static async create(
    windowMode: E2eWindowMode,
    testInfo: Pick<TestInfo, 'attach'>
  ): Promise<ElectronAppHarness> {
    const testRoot = await mkdtemp(join(tmpdir(), 'open-science-electron-e2e-'))
    const harness = new ElectronAppHarness(
      testRoot,
      {
        fakeAgentBinRoot: join(testRoot, 'fake-agent-bin'),
        fakeRemoteItRoot: join(testRoot, 'fake-remoteit'),
        fakeRemoteItState: join(testRoot, 'fake-remoteit-state.json'),
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
      await harness
        .captureMainLog('startup-failure.log')
        .then((path) =>
          testInfo.attach('startup-main-process-log', { path, contentType: 'text/plain' })
        )
        .catch(() => undefined)
      try {
        await harness.dispose()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Electron fixture startup and cleanup failed.'
        )
      }
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

  async captureMainLog(name: string): Promise<string> {
    if (!/^[a-z0-9-]+\.log$/u.test(name)) throw new Error(`Invalid E2E log name: ${name}`)
    const evidenceRoot = resolve('.scratch', 'notebook-lifecycle-e2e', 'evidence')
    await mkdir(evidenceRoot, { recursive: true })
    const destination = join(evidenceRoot, name)
    if (!this.mainLogDirectory) throw new Error('Electron log directory is unavailable.')
    await copyFile(join(this.mainLogDirectory, 'main.log'), destination)
    if (this.flushTimeline) {
      await appendFile(
        destination,
        `\n--- Electron E2E flush timeline ---\n${this.flushTimeline}`
      ).catch(() => undefined)
    }
    return destination
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
    return this.runningApplication.evaluate(captureNativeQuitDialog)
  }

  async markResourceProfilePhase(phase: string): Promise<void> {
    if (!this.resourceProfiler) throw new Error('Runtime resource profiling is not active.')
    this.resourceProfiler.markPhase(phase)
    await this.resourceProfiler.sampleNow()
  }

  recordResourceTiming(name: string, durationMs: number): void {
    this.resourceProfiler?.recordTiming(name, durationMs)
  }

  async captureResourceTimings(prefix = ''): Promise<void> {
    if (!this.resourceProfiler) return
    const collect = (): { name: string; duration: number }[] => {
      const names = new Set([
        'open-science:ipc-registration',
        'open-science:renderer-bootstrap',
        'open-science:i18n-init',
        'open-science:i18n-locale-switch',
        'open-science:persistence-runtime-lookup-fallback',
        'open-science:persistence-runtime-lookup-catalog',
        'open-science:persistence-runtime-lookup-ownership',
        'open-science:persistence-runtime-lookup-read',
        'open-science:persistence-runtime-lookup-targeted'
      ])
      const timings = performance
        .getEntriesByType('measure')
        .filter((entry) => names.has(entry.name))
        .map(({ name, duration }) => ({ name, duration }))
      for (const name of names) performance.clearMeasures(name)
      for (const entry of performance.getEntriesByType('paint')) {
        if (entry.name === 'first-paint' || entry.name === 'first-contentful-paint') {
          timings.push({ name: entry.name, duration: entry.startTime })
        }
      }
      return timings
    }
    for (const timing of [
      ...(await this.runningApplication.evaluate(collect)),
      ...(await this.page.evaluate(collect))
    ])
      this.resourceProfiler.recordTiming(prefix + timing.name, timing.duration)
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

  // Keep real renderer/preload navigation while replacing the external SSH directory read.
  // This isolated Electron process is disposed after the test, including its IPC handler.
  async configureFileBrowserFixture(): Promise<void> {
    await this.runningApplication.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('compute:list-dir')
      ipcMain.handle('compute:list-dir', () => ({
        entries: [],
        truncated: false,
        roots: { home: '/home/fixture', scratch: '/scratch/fixture' },
        resolvedPath: '/home/fixture'
      }))
    })
    await this.page.evaluate(async () => {
      const bridge = window as unknown as {
        api: {
          compute: {
            create: (request: { sshAlias: string; displayName: string }) => Promise<unknown>
            bookmarksSet: (providerId: string, paths: string[]) => Promise<unknown>
          }
        }
      }
      await bridge.api.compute.create({
        sshAlias: 'a11y-fixture',
        displayName: 'Accessibility fixture'
      })
      await bridge.api.compute.bookmarksSet('ssh:a11y-fixture', ['/scratch/fixture/pinned'])
    })
  }

  async openAdditionalRenderer(): Promise<Page> {
    const next = this.runningApplication.waitForEvent('window')
    await this.runningApplication.evaluate(
      ({ BrowserWindow }, preload) => {
        const source = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('index.html')
        )!
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        })
        void window.loadURL(source.webContents.getURL())
      },
      fileURLToPath(new URL('../preload/index.js', this.page.url()))
    )
    const page = await next
    await page.waitForFunction(() => Boolean(window.api?.databaseStartup))
    await waitForRendererReady(page)
    return page
  }

  async authenticatedWebUrl(): Promise<string> {
    const target = electronLaunchTarget(this.roots.userDataRoot)
    const child = spawn(
      target.executablePath ?? ((await import('electron')).default as unknown as string),
      [...target.args, '--serve=0'],
      { env: launchEnvironment(this.roots.storageRoot), stdio: 'ignore' }
    )
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => resolve())
    })
    let port: number | undefined
    await expect
      .poll(async () => {
        try {
          port = (
            JSON.parse(
              await readFile(join(this.roots.storageRoot, 'web-service.json'), 'utf8')
            ) as { port: number }
          ).port
        } catch {
          return false
        }
        return Boolean(port)
      })
      .toBe(true)
    const token = (await readFile(join(this.roots.storageRoot, 'web-token'), 'utf8')).trim()
    return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
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
    if (
      process.env.OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS ||
      process.env.OPEN_SCIENCE_E2E_REAL_MICROMAMBA
    ) {
      // Keep lifecycle checks on the mutation path itself. Without an explicit channel,
      // named-environment creation first performs an unrelated live mirror probe.
      settings.packageMirror = {
        condaChannel: process.env.OPEN_SCIENCE_E2E_REAL_MICROMAMBA
          ? 'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/'
          : 'conda-forge'
      }
    }
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

  async emitSessionPackageProgress(snapshot: PackageOperationSnapshot): Promise<void> {
    // Presentation fixtures use the existing native event boundary, without a production test seam.
    await this.runningApplication.evaluate(({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        'sessions:package-operation-changed',
        snapshot
      )
    }, snapshot)
  }

  async restartWithPackage(path: string): Promise<Page> {
    await this.close()
    await this.launch(path)
    return this.page
  }

  async emitPackageFileOpen(path: string): Promise<void> {
    await this.runningApplication.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault: () => undefined }, path)
    }, path)
  }

  async configureSessionPackageDialogs(options?: { availableBytes?: number }): Promise<string> {
    const archive = join(this.testRoot, 'research.science')
    if (options?.availableBytes !== undefined)
      await this.runningApplication.evaluate((_electron, freeBytes) => {
        const fs = process.getBuiltinModule('node:fs/promises')
        fs.statfs = new Proxy(fs.statfs, {
          apply: async (original, receiver, args) => {
            const stats = await Reflect.apply(original, receiver, args)
            stats.bavail = typeof stats.bavail === 'bigint' ? BigInt(freeBytes) : freeBytes
            stats.bsize = typeof stats.bsize === 'bigint' ? 1n : 1
            return stats
          }
        })
      }, options.availableBytes)
    await this.runningApplication.evaluate(({ dialog }, archive) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: archive })
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] })
    }, archive)
    return archive
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
        const contents = (view as Electron.WebContentsView).webContents
        if (!contents || contents.isDestroyed() || !contents.getURL().includes('/find-overlay/'))
          return false
        const bounds = view.getBounds()
        return bounds.width > 0 && bounds.height > 0
      })
    })
  }

  async mainWindowState(): Promise<{ minimized: boolean; visible: boolean }> {
    return this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open-Science main window was not found.')

      return { minimized: mainWindow.isMinimized(), visible: mainWindow.isVisible() }
    })
  }

  async auditSourceAttachments(): Promise<JSHandle<boolean[]>> {
    return this.runningApplication.evaluateHandle(({ BrowserWindow }) => {
      const decisions: boolean[] = []
      // Installed after production: observe its real preventDefault decision before guest creation.
      BrowserWindow.getAllWindows()[0].webContents.on('will-attach-webview', (event) => {
        decisions.push(event.defaultPrevented)
      })
      return decisions
    })
  }

  // Trust only the current test's loopback certificate; retain normal verification elsewhere.
  async trustSourcePreviewCertificate(certificate: string): Promise<void> {
    await this.runningApplication.evaluate(({ session }, certificate) => {
      session
        .fromPartition('persist:open-science-source-preview-v1')
        .setCertificateVerifyProc((request, callback) => {
          callback(
            request.hostname === '127.0.0.1' &&
              request.certificate.data.trim() === certificate.trim()
              ? 0
              : -3
          )
        })
    }, certificate)
  }

  async setDefaultSessionCookie(url: string): Promise<void> {
    await this.runningApplication.evaluate(async ({ session }, cookieUrl) => {
      await session.defaultSession.cookies.set({
        url: cookieUrl,
        name: 'hostOnlyCookie',
        value: 'host-session',
        path: '/'
      })
    }, url)
  }

  async readClipboardText(): Promise<string> {
    return this.runningApplication.evaluate(({ clipboard }) => clipboard.readText())
  }

  async emitUpdateStatus(status: UpdateStatus): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, nextStatus) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      mainWindow.webContents.send('update:status', nextStatus)
    }, status)
  }

  async emitSkillImportApprovalRequest(
    request: ConversationSkillImportApprovalRequest
  ): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, nextRequest) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open Science main window was not found.')
      mainWindow.webContents.send('skills:conversation-import-request', nextRequest)
    }, request)
  }

  async showMainWindow(): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open-Science main window was not found.')
      mainWindow.show()
    })
    await expect.poll(() => this.mainWindowState()).toMatchObject({ visible: true })
  }

  async setMainWindowSize(width: number, height: number): Promise<void> {
    await this.runningApplication.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        BrowserWindow.getAllWindows()[0].setSize(width, height)
      },
      { width, height }
    )
  }

  async pressSourcePreviewShortcut(
    url: string,
    key: string,
    modifiers: ShortcutModifier[] = []
  ): Promise<void> {
    await this.runningApplication.evaluate(
      ({ webContents }, { url, key, modifiers }) => {
        const contents = webContents
          .getAllWebContents()
          .find(
            (candidate) =>
              candidate.getType() === 'webview' &&
              !candidate.isDestroyed() &&
              candidate.getURL() === url
          )
        if (!contents) throw new Error('Source preview was not found.')
        contents.focus()
        contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      },
      { url, key, modifiers }
    )
  }

  async setMainWindowZoomFactor(factor: number): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, nextFactor) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open-Science main window was not found.')
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
        if (!mainWindow) throw new Error('Open-Science main window was not found.')

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
      if (!mainWindow) throw new Error('Open-Science main window was not found.')
      mainWindow.close()
    })
  }

  async emitPreviewContextMenuAtCssPoint(point: { x: number; y: number }): Promise<void> {
    await this.runningApplication.evaluate(({ BrowserWindow }, cssPoint) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Open-Science main window was not found.')
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

  async captureBrandState(): Promise<BrandState> {
    return this.runningApplication.evaluate(({ app, BrowserWindow, Menu }) => ({
      name: app.getName(),
      packaged: app.isPackaged,
      profile: app.getPath('userData'),
      logs: app.getPath('logs'),
      title: BrowserWindow.getAllWindows()[0]?.getTitle() ?? '',
      menus: Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
    }))
  }

  async restartWithBrandFixture(
    mode: 'legacy' | 'legacy-config' | 'custom' | 'onboarding'
  ): Promise<Page> {
    await this.close()
    await prepareBrandStorageFixture(
      this.roots.storageRoot,
      this.testRoot,
      mode,
      Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE)
    )
    await this.launch()
    return this.page
  }

  async restart(options: { resourceProfilePhase?: string } = {}): Promise<Page> {
    await this.close()
    if (options.resourceProfilePhase) {
      if (!this.resourceProfiler) throw new Error('Runtime resource profiling is not active.')
      this.resourceProfiler.markPhase(options.resourceProfilePhase)
    }
    await this.launch(
      undefined,
      options.resourceProfilePhase === 'recovery' ? 'recovery-startup-ready' : 'startup-ready'
    )
    return this.page
  }

  async restartAfterCrash(options: { force?: boolean } = {}): Promise<Page> {
    const application = this.application
    if (!application) throw new Error('No Electron process is available to terminate.')
    const child = application.process()
    const before =
      process.platform === 'win32' && child.pid !== undefined
        ? await readProcessTree(child.pid)
        : undefined
    const result = await terminateProcessTree(child, options.force ? 'SIGKILL' : undefined)
    let reaped = result.reaped
    // Windows termination is asynchronous even when taskkill succeeds. Playwright's child is
    // a shell, so wait for the observed Electron descendants too before reusing the profile lock.
    if (process.platform === 'win32') {
      reaped = false
      if (before?.complete) {
        const deadline = Date.now() + 10_000
        do {
          const after = await readProcessTable()
          reaped =
            after.complete &&
            before.processes.every(
              ({ pid }) => selectProcessTree(after.processes, pid).length === 0
            )
          if (reaped || Date.now() >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        } while (Date.now() < deadline)
      }
    }
    if (!reaped) throw new Error('Electron crash simulation did not reap the process tree.')
    this.resourceProfiler?.detach(application)
    this.application = undefined
    this.currentPage = undefined
    await this.launch()
    return this.page
  }

  async restartWithSessionFixture(session: PersistedChatSession): Promise<Page> {
    if (![session.projectId, session.id].every((id) => /^[a-zA-Z0-9_-]+$/.test(id))) {
      throw new Error('Invalid E2E Session fixture identity.')
    }
    await this.close()
    const directory = join(this.roots.storageRoot, 'sessions', session.projectId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, `${session.id}.json`),
      JSON.stringify(createSessionFile(session))
    )
    // Rebuild the catalog from the fixture file, just as the historical-session fixture does.
    const client = createProjectDbClient(this.roots.storageRoot)
    try {
      await client.sessionProjectionState.deleteMany()
    } finally {
      await client.$disconnect()
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
    const errors: unknown[] = []
    try {
      await this.closeForCleanup()
      await makeTreeWritable(this.testRoot)
      await removeTreeForCleanup(this.testRoot)
    } catch (error) {
      errors.push(error)
    }
    try {
      this.rendererFailures.assertNoFailures()
    } catch (error) {
      if (errors.length === 0) throw error
      errors.push(error)
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Electron fixture cleanup failed; inspect ${this.testRoot}: ${errors.map(String).join('; ')}`
      )
    }
  }

  // Keep real Chromium redirect handling while replacing external GitHub traffic with a local
  // HTTP fixture. URL admission still sees the original URL; only the transport destination changes.
  async routeMarketplaceRequests(origin: string): Promise<void> {
    await this.runningApplication.evaluate(({ net }, origin) => {
      const fetch = net.fetch.bind(net)
      const request = net.request.bind(net)
      const route = (url: string): string =>
        url.startsWith(origin + '/') ? url : `${origin}/${encodeURIComponent(url)}`
      net.fetch = (input, init) => fetch(route(String(input)), init)
      net.request = (options) =>
        request(
          typeof options === 'string' ? route(options) : { ...options, url: route(options.url!) }
        )
    }, origin)
  }

  private async launch(packagePath?: string, timingName = 'startup-ready'): Promise<void> {
    const launchStartedAt = performance.now()
    this.application = await launchOpenScience(
      this.roots,
      this.fakeAgentEnabled,
      this.fakeRemoteItEnabled,
      this.roots.fakeRemoteItRoot,
      this.windowMode,
      this.resourceProfiler !== undefined,
      packagePath
    )
    await this.resourceProfiler?.attach(this.application)
    try {
      if (process.env.OPEN_SCIENCE_E2E_EXECUTABLE) {
        const evidence = await this.application.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          executable: process.execPath,
          version: app.getVersion()
        }))
        const revision = process.env.OPEN_SCIENCE_E2E_EXPECTED_BUILD_SHA
        if (
          !evidence.packaged ||
          !evidence.appPath.endsWith('app.asar') ||
          evidence.executable !== process.env.OPEN_SCIENCE_E2E_EXECUTABLE ||
          (revision && !evidence.version.endsWith(`-nightly.${revision.slice(0, 7)}`))
        ) {
          throw new Error(`Packaged Electron identity mismatch: ${JSON.stringify(evidence)}`)
        }
        console.info('Packaged Electron identity:', JSON.stringify(evidence))
      }
      this.currentPage = await openMainWindow(
        this.application,
        this.rendererFailures,
        this.windowMode,
        this.resourceProfiler
          ? async (page) => {
              this.currentPage = page
              this.recordResourceTiming('first-' + timingName, performance.now() - launchStartedAt)
              await this.captureResourceTimings(
                timingName === 'recovery-startup-ready' ? 'first-recovery:' : 'first:'
              )
            }
          : undefined
      )
      this.recordResourceTiming(timingName, performance.now() - launchStartedAt)
      if (process.platform === 'win32' || process.env.OPEN_SCIENCE_E2E_FLUSH_DIAGNOSTICS === '1') {
        this.stopFlushDiagnostics = await observeElectronFlushDiagnostics(
          this.application,
          this.currentPage,
          (line) => {
            this.flushTimeline += line + '\n'
          }
        )
      }
    } finally {
      this.mainLogDirectory = await this.application
        .evaluate(({ app }) => app.getPath('logs'))
        .catch(() => undefined)
    }
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
    await this.closeForCleanup(true)
  }

  private async closeForCleanup(requireGraceful = false): Promise<void> {
    if (!this.application) return

    const application = this.application
    const page = this.currentPage
    this.resourceProfiler?.detach(application)
    this.application = undefined
    this.currentPage = undefined
    await closeElectronApplicationForCleanup(
      {
        close: async () => {
          if (requireGraceful && page) {
            const readWindowId = async (): Promise<number> =>
              (await application.browserWindow(page)).evaluate((window) => window.id)
            let windowId: number
            try {
              windowId = await readWindowId()
            } catch (error) {
              if (!String(error).includes('Resulting promise was garbage collected')) throw error
              windowId = await readWindowId()
            }
            await installRestartPersistenceRetry(application, windowId, 5_000)
          }
          await application.close()
        },
        forceClose: async () => {
          const result = await terminateProcessTree(application.process())
          if (!result.reaped)
            throw new Error('Electron E2E forced close did not reap the process tree.')
        }
      },
      {
        gracefulTimeoutMs: CLEANUP_GRACEFUL_TIMEOUT_MS,
        forcedTimeoutMs: CLEANUP_FORCED_TIMEOUT_MS,
        requireGraceful
      }
    ).finally(() => {
      this.stopFlushDiagnostics?.()
      this.stopFlushDiagnostics = undefined
    })
  }
}

const test = base.extend<{ app: ElectronApp; windowMode: E2eWindowMode }>({
  windowMode: ['hidden', { option: true }],
  // Playwright fixture callbacks require an object pattern even when no base fixture is needed.
  app: [
    async ({ windowMode }, install, testInfo) => {
      const app = await ElectronAppHarness.create(windowMode, testInfo)

      let bodyError: unknown
      try {
        await install(app)
      } catch (error) {
        bodyError = error
      }
      if (testInfo.status !== testInfo.expectedStatus) {
        // Preserve the original test failure even if shutdown left no readable log.
        await app
          .captureMainLog('test-failure.log')
          .then((path) => testInfo.attach('main-process-log', { path, contentType: 'text/plain' }))
          .catch(() => undefined)
      }
      try {
        await app.dispose()
      } catch (cleanupError) {
        await app
          .captureMainLog('cleanup-failure.log')
          .then((path) =>
            testInfo.attach('cleanup-main-process-log', { path, contentType: 'text/plain' })
          )
          .catch(() => undefined)
        if (bodyError !== undefined) {
          throw new AggregateError([bodyError, cleanupError], 'Electron test and cleanup failed.')
        }
        throw cleanupError
      }
      if (bodyError !== undefined) throw bodyError
    },
    process.platform === 'win32' ? { timeout: 240_000 } : {}
  ]
})

export {
  closeElectronApplicationForCleanup,
  installRestartPersistenceRetry,
  observeElectronFlushDiagnostics,
  electronLaunchTarget,
  launchEnvironment,
  removeTreeForCleanup,
  STAR_NUDGE_LAST_SHOWN_STORAGE_KEY,
  suppressWorkspaceStarNudge,
  test
}
export type { ElectronApp }
