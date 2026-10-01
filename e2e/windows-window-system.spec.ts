import { expect, test as nativeTest } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { release } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright'
import { electronLaunchTarget, launchEnvironment, test } from './fixtures/electron-app'
import { terminateProcessTree } from '../src/main/process-tree'

const execFileAsync = promisify(execFile)
type ProcessPower = {
  pid: number
  priority: number
  controlMask: number
  stateMask: number
  ecoQoS: boolean
}
type WindowProcessPower = { main: ProcessPower; renderer: ProcessPower }

nativeTest(
  'restores native renderer efficiency mode across window transitions @pr-mainline-windows',
  async ({ browserName }, testInfo) => {
    expect(browserName).toBe('chromium')
    nativeTest.skip(
      process.platform !== 'win32' ||
        Number(release().split('.')[2]) < 22621 ||
        Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
      'Native efficiency mode requires a source Electron launch on Windows 11 22H2 or later.'
    )
    nativeTest.setTimeout(240_000)
    const storageRoot = testInfo.outputPath('storage')
    const dataRoot = resolve(storageRoot, 'data')
    const userDataRoot = testInfo.outputPath('electron-profile')
    const evidencePath = testInfo.outputPath('windows-process-power.json')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(
      resolve(storageRoot, 'settings.json'),
      JSON.stringify({
        version: 2,
        onboardingCompletedAt: 1,
        dataRoot,
        localePreference: 'en',
        closePreference: 'minimize'
      })
    )
    const target = electronLaunchTarget(userDataRoot)
    const environment: Record<string, string> = {
      ...launchEnvironment(storageRoot, undefined, process.env, undefined, 'normal'),
      OPEN_SCIENCE_USER_DATA: userDataRoot,
      OPEN_SCIENCE_POWER_EVIDENCE: evidencePath,
      OPEN_SCIENCE_POWER_QUERY: resolve('e2e/fixtures/windows-process-power.ps1')
    }
    delete environment['ELECTRON_RUN_AS_NODE']
    const executable = createRequire(resolve('package.json'))('electron') as string
    // No debugger: Playwright's loader switches and CDP focus emulation prevent real backgrounding.
    const running = execFileAsync(
      executable,
      ['--require', resolve('e2e/fixtures/windows-renderer-efficiency.cjs'), ...target.args],
      { cwd: process.cwd(), env: environment, windowsHide: true }
    )
    // Keep the leader alive until tree cleanup: execFile's timeout would kill only that process.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error('Native efficiency test exceeded its 210-second launch budget.')),
        210_000
      )
    })
    try {
      await Promise.race([running, deadline])
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as {
        completed: boolean
        phases: Record<string, WindowProcessPower & { backgroundThrottling: boolean }>
      }
      expect(evidence.completed).toBe(true)
      expect(Object.keys(evidence.phases)).toEqual([
        'visible',
        'minimized',
        'restored',
        'tray',
        'shown-from-tray',
        'reloaded',
        'minimized-after-reload'
      ])
      for (const phase of Object.values(evidence.phases))
        expect(phase.backgroundThrottling).toBe(true)
    } finally {
      clearTimeout(deadlineTimer)
      if (running.child.exitCode === null && running.child.signalCode === null) {
        const result = await terminateProcessTree(running.child, 'SIGKILL')
        expect(result.reaped, 'Native efficiency test process cleanup').toBe(true)
      }
      await testInfo
        .attach('windows-process-power', { path: evidencePath, contentType: 'application/json' })
        .catch(() => undefined)
    }
  }
)

const openGeneralSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  return settings
}

test.describe('Windows window system', () => {
  test.skip(process.platform !== 'win32', 'Windows window behavior requires a Windows host.')
  test.use({ windowMode: 'normal' })

  test.beforeEach(async ({ app }) => {
    // These locators use English copy; the test host may use another system language.
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  })

  test('uses interface scale steps for Windows plus aliases and reset shortcuts @pr-mainline-windows', async ({
    app
  }, testInfo) => {
    const page = await app.completeOnboarding()
    await app.setMainWindowZoomFactor(1)
    const pixelRatio = (): Promise<number> => page.evaluate(() => window.devicePixelRatio)
    const baseline = await pixelRatio()
    await testInfo.attach('zoom-before', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })

    for (const key of ['=', 'numadd']) {
      for (const expectedScale of [1.1, 1.25, 1.25]) {
        await app.pressMainWindowShortcut(key, ['control'])
        await expect.poll(async () => (await pixelRatio()) / baseline).toBeCloseTo(expectedScale, 4)
      }
      await testInfo.attach(`zoom-after-${key === '=' ? 'equal' : 'numpad'}`, {
        body: await page.screenshot(),
        contentType: 'image/png'
      })
      await app.pressMainWindowShortcut('0', ['control'])
      await expect.poll(pixelRatio).toBeCloseTo(baseline, 4)
    }

    await app.pressMainWindowShortcut('+', ['control', 'shift'])
    await expect.poll(async () => (await pixelRatio()) / baseline).toBeCloseTo(1.1, 4)
    await app.pressMainWindowShortcut('-', ['control'])
    await expect.poll(pixelRatio).toBeCloseTo(baseline, 4)
  })

  test('persists minimize-to-tray across titlebar close, relaunch, and Ctrl+W @pr-mainline-windows', async ({
    app
  }) => {
    let page = await app.completeOnboarding()
    let settings = await openGeneralSettings(page)
    const closeAction = settings.getByRole('combobox', { name: 'When closing the window' })

    await closeAction.click()
    await page.getByRole('option', { name: 'Minimize to tray' }).click()
    await expect(closeAction).toContainText('Minimize to tray')
    await settings.getByRole('button', { name: 'Close settings' }).click()

    page = await app.restart()
    settings = await openGeneralSettings(page)
    await expect(settings.getByRole('combobox', { name: 'When closing the window' })).toContainText(
      'Minimize to tray'
    )
    await settings.getByRole('button', { name: 'Close settings' }).click()

    await app.requestMainWindowClose()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })

    await app.launchSecondInstance()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: true })

    await app.pressMainWindowShortcut('W', ['control'])
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: false })

    page = await app.launchSecondInstance()
    await expect.poll(() => app.mainWindowState()).toEqual({ minimized: false, visible: true })
    await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  })

  test('opens the whole-window find overlay with Ctrl+F in a workspace', async ({ app }) => {
    const page = await app.completeOnboarding()
    await page.getByRole('button', { name: 'New project' }).click()
    const projectDialog = page.getByRole('dialog', { name: 'New project' })
    await projectDialog.getByLabel('Name').fill('Windows find project')
    await projectDialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

    await expect.poll(() => app.findOverlayIsVisible()).toBe(false)
    await app.pressMainWindowShortcut('F', ['control'])
    await expect.poll(() => app.findOverlayIsVisible()).toBe(true)
  })
})
