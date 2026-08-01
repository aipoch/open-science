import { test as base } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const APP_ROOT = resolve(process.cwd())

type LaunchRoots = {
  storageRoot: string
  userDataRoot: string
}

type ShortcutModifier = 'alt' | 'control' | 'meta' | 'shift'

type ElectronApp = {
  readonly page: Page
  completeOnboarding: () => Promise<Page>
  findOverlayIsVisible: () => Promise<boolean>
  launchSecondInstance: () => Promise<Page>
  mainWindowState: () => Promise<{ minimized: boolean; visible: boolean }>
  pressMainWindowShortcut: (key: string, modifiers: ShortcutModifier[]) => Promise<void>
  requestMainWindowClose: () => Promise<void>
  restart: () => Promise<Page>
}

const launchEnvironment = (storageRoot: string): Record<string, string> => {
  const environment: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') environment[key] = value
  }

  environment.OPEN_SCIENCE_STORAGE_ROOT = storageRoot
  return environment
}

const launchOpenScience = ({
  storageRoot,
  userDataRoot
}: LaunchRoots): Promise<ElectronApplication> =>
  electron.launch({
    args: [`--user-data-dir=${userDataRoot}`, APP_ROOT],
    cwd: APP_ROOT,
    env: launchEnvironment(storageRoot)
  })

const observeRendererFailures = (page: Page): void => {
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[renderer console] ${message.text()}`)
  })
  page.on('pageerror', (error) => console.error('[renderer pageerror]', error))
}

const openMainWindow = async (application: ElectronApplication): Promise<Page> => {
  const page = await application.firstWindow()
  observeRendererFailures(page)
  await page.waitForLoadState('domcontentloaded')
  return page
}

class ElectronAppHarness implements ElectronApp {
  private application: ElectronApplication | undefined
  private currentPage: Page | undefined

  private constructor(
    private readonly testRoot: string,
    private readonly roots: LaunchRoots
  ) {}

  static async create(): Promise<ElectronAppHarness> {
    const testRoot = await mkdtemp(join(tmpdir(), 'open-science-electron-e2e-'))
    const harness = new ElectronAppHarness(testRoot, {
      storageRoot: join(testRoot, 'storage'),
      userDataRoot: join(testRoot, 'electron-profile')
    })
    await harness.launch()
    return harness
  }

  get page(): Page {
    if (!this.currentPage) throw new Error('Electron application is not running.')
    return this.currentPage
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

  async launchSecondInstance(): Promise<Page> {
    const { appPath, executable } = await this.runningApplication.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      executable: process.execPath
    }))
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      const child = spawn(executable, [`--user-data-dir=${this.roots.userDataRoot}`, appPath], {
        cwd: APP_ROOT,
        env: launchEnvironment(this.roots.storageRoot),
        stdio: 'ignore'
      })
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

  async restart(): Promise<Page> {
    await this.close()
    await this.launch()
    return this.page
  }

  async dispose(): Promise<void> {
    await this.close().catch(() => undefined)
    await rm(this.testRoot, { force: true, recursive: true })
  }

  private async launch(): Promise<void> {
    this.application = await launchOpenScience(this.roots)
    this.currentPage = await openMainWindow(this.application)
  }

  private get runningApplication(): ElectronApplication {
    if (!this.application) throw new Error('Electron application is not running.')
    return this.application
  }

  private async close(): Promise<void> {
    if (!this.application) return

    const application = this.application
    this.application = undefined
    this.currentPage = undefined
    await application.close()
  }
}

const test = base.extend<{ app: ElectronApp }>({
  // Playwright fixture callbacks require an object pattern even when no base fixture is needed.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, install) => {
    const app = await ElectronAppHarness.create()

    try {
      await install(app)
    } finally {
      await app.dispose()
    }
  }
})

export { test }
export type { ElectronApp }
