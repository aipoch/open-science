import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

const APP_ROOT = resolve(process.cwd())
const PROJECT_NAME = 'Electron E2E project'

type LaunchRoots = {
  storageRoot: string
  userDataRoot: string
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

const closeApplication = async (application: ElectronApplication | undefined): Promise<void> => {
  if (!application) return
  await application.close()
}

test('creates a project through the desktop stack and reloads it after relaunch', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'open-science-electron-e2e-'))
  const roots: LaunchRoots = {
    storageRoot: join(testRoot, 'storage'),
    userDataRoot: join(testRoot, 'electron-profile')
  }
  let application: ElectronApplication | undefined

  try {
    application = await launchOpenScience(roots)
    let page = await openMainWindow(application)

    await expect(
      page.getByRole('heading', { name: 'Set up your research workspace.' })
    ).toBeVisible()

    // Use the production preload bridge to seed only the external-provider-dependent prerequisite.
    // Everything after this point is visible UI backed by the real main process and project database.
    await page.evaluate(async () => {
      const bridge = globalThis as unknown as {
        api: { settings: { markOnboardingComplete: () => Promise<unknown> } }
      }
      await bridge.api.settings.markOnboardingComplete()
    })
    await page.reload({ waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(PROJECT_NAME)
    await dialog.getByLabel('Description').fill('Created through the real Electron IPC boundary.')
    await dialog.getByRole('button', { name: 'Create project' }).click()

    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All projects' })).toBeVisible()

    await closeApplication(application)
    application = undefined

    application = await launchOpenScience(roots)
    page = await openMainWindow(application)

    const projects = page.getByRole('region', { name: 'Projects' })
    await expect(projects.getByRole('button', { name: PROJECT_NAME, exact: true })).toBeVisible()
  } finally {
    await closeApplication(application).catch(() => undefined)
    await rm(testRoot, { force: true, recursive: true })
  }
})
