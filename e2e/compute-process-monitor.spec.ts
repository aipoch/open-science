import { dirname } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { setTheme } from './fixtures/settings-preferences'

test.use({ windowMode: 'normal' })
test('monitors real owned kernels through Compute and delivers stop feedback to the session agent', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  for (const [language, path] of [
    ['python', process.env.OPEN_SCIENCE_TEST_PYTHON],
    ['r', process.env.OPEN_SCIENCE_TEST_R]
  ] as const) {
    if (!path) continue
    await page.evaluate(
      async ({ language, path, runtimeRoot }) => {
        await window.api.localFs.grantRoot({ path: runtimeRoot, access: 'ro' })
        await window.api.runtime.registerInterpreter(language, path)
        const runtimes = await window.api.runtime.listEnvironments()
        const runtime = runtimes[language].find(
          (row) => row.interpreterPath === path || row.envId === path
        )
        if (!runtime) throw new Error(`Missing ${language} runtime`)
        await window.api.runtime.setEnvironmentEnabled(language, runtime.envId, true)
      },
      { language, path, runtimeRoot: dirname(dirname(path)) }
    )
  }
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'auto' }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await createProjectViaUi(page, 'Compute monitor acceptance')
  await submitPromptViaUi(page, 'Start Compute monitor kernels.')
  await expect(page.getByText('Compute kernels ready.', { exact: true })).toBeVisible({
    timeout: 120_000
  })
  await page.getByRole('button', { name: 'Compute', exact: true }).click()
  const monitor = page.getByRole('region', { name: 'Local process monitor', exact: true })
  await expect(monitor).toBeVisible()
  const expectedKinds = [
    'repl',
    'shell',
    ...(process.env.OPEN_SCIENCE_TEST_PYTHON ? ['python'] : []),
    ...(process.env.OPEN_SCIENCE_TEST_R ? ['r'] : [])
  ]
  const snapshot = await page.evaluate(() => window.api.notebook.getProcessMonitor())
  expect(snapshot.instances.map((item) => item.kind).sort()).toEqual(expectedKinds.sort())
  expect(snapshot.instances.every((item) => item.pid && item.memoryBytes! > 0)).toBe(true)
  expect(snapshot.instances.every((item) => item.lastCell === undefined)).toBe(true)
  await expect(monitor.locator('pre')).toHaveCount(0)
  await expect(monitor.locator('details[data-kernel-details]')).toHaveCount(0)
  await monitor.locator('button[aria-controls]').first().click()
  const row = monitor.locator('details').filter({
    has: page.getByRole('img', {
      name: process.env.OPEN_SCIENCE_TEST_R ? 'R' : 'JavaScript REPL',
      exact: true
    })
  })
  await row.locator('summary').click()
  await expect(row.getByRole('region', { name: 'Last cell', exact: true })).toContainText(
    process.env.OPEN_SCIENCE_TEST_R ? 'monitor_values <-' : 'var monitorValues'
  )
  await expect(row.getByText('Process ID', { exact: true })).toBeVisible()
  const preview = row.getByRole('region', { name: 'Last cell', exact: true })
  await expect(preview.locator('code span').first()).toBeVisible()
  const observation = await preview.evaluateHandle((element) => {
    element.scrollTop = 100
    const state = {
      mutations: 0,
      scrollTop: element.scrollTop,
      observer: undefined as MutationObserver | undefined
    }
    state.observer = new MutationObserver((records) => {
      state.mutations += records.length
    })
    state.observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    })
    return state
  })
  // Two automatic metric polls must leave highlighted DOM and source scrolling untouched.
  const initialSample = snapshot.sampledAt
  await expect
    .poll(
      async () => (await page.evaluate(() => window.api.notebook.getProcessMonitor())).sampledAt,
      { intervals: [3000], timeout: 15_000 }
    )
    .toBeGreaterThan(initialSample + 4000)
  expect(await observation.evaluate((state) => state.mutations)).toBe(0)
  expect(await preview.evaluate((element) => element.scrollTop)).toBe(
    await observation.evaluate((state) => state.scrollTop)
  )
  await observation.evaluate((state) => state.observer?.disconnect())
  await monitor
    .getByRole('heading', { name: 'Local computer', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('compute-light.png') })
  await setTheme(page, 'Dark')
  await page.screenshot({ path: testInfo.outputPath('compute-dark.png') })
  await app.setMainWindowSize(650, 820)
  await page.screenshot({ path: testInfo.outputPath('compute-narrow.png') })
  await app.setMainWindowSize(1200, 900)
  await monitor.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop all', exact: true }).click()
  const form = monitor.getByRole('form', { name: 'Stop all session kernels', exact: true })
  await form.getByRole('textbox').fill('Use smaller batches')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(
    (await page.evaluate(() => window.api.notebook.getProcessMonitor())).instances
  ).toHaveLength(expectedKinds.length)
  await monitor.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Stop all', exact: true }).click()
  await form.getByRole('textbox').fill('Use smaller batches')
  await form.getByRole('button', { name: 'Terminate', exact: true }).click()
  await expect(monitor.getByText('No tracked Notebook processes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Compute', exact: true }).click()
  await submitPromptViaUi(page, 'Read Compute stop feedback.')
  await expect(
    page.getByText('Compute stop feedback received: Use smaller batches; stopped.', { exact: true })
  ).toBeVisible()
})

test('delivers the reason in the interrupted running kernel tool response', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.evaluate(() => window.api.settings.setDefaultPermissionProfile({ profile: 'auto' }))
  await createProjectViaUi(page, 'Compute running stop acceptance')
  await submitPromptViaUi(page, 'Start busy Compute kernel.')
  await page.getByRole('button', { name: 'Compute', exact: true }).click()
  const monitor = page.getByRole('region', { name: 'Local process monitor', exact: true })
  await monitor.locator('button[aria-controls]').first().click()
  await expect(monitor.getByRole('img', { name: 'Shell', exact: true })).toBeVisible()
  await expect(monitor.locator('[data-kernel-details] summary')).toContainText('Running')
  await monitor.getByRole('button', { name: 'Terminate', exact: true }).click()
  const form = monitor.getByRole('form', { name: 'Stop this kernel?', exact: true })
  await form.getByRole('textbox').fill('Use smaller batches')
  await form.getByRole('button', { name: 'Terminate', exact: true }).click()
  await expect(monitor.getByText('No tracked Notebook processes', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Compute', exact: true }).click()
  await expect(
    page.getByText('Compute running stop feedback received.', { exact: true })
  ).toBeVisible()
})
