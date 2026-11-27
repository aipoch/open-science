import { expect } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { x as extract } from 'tar'
import { tmpdir } from 'node:os'
import type { NotebookNetworkAuditRecord } from '../src/shared/notebook-network-audit'
import { test } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'

test.use({ windowMode: 'normal' })
test('switches between network log filters with one click and dismisses on leaving', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = app.page
  const settings = await openSettingsPage(page, 'Network')
  await settings
    .getByRole('region', { name: 'Notebook network access' })
    .getByRole('button', { name: 'Open', exact: true })
    .click()
  const mode = settings.getByLabel('Network mode', { exact: true })
  const decision = settings.getByLabel('Decision', { exact: true })
  const result = settings.getByLabel('Result', { exact: true })
  const heading = settings.getByRole('heading', { name: 'Notebook network logs', exact: true })
  await mode.click()
  await page.getByRole('menuitemradio', { name: 'Strict', exact: true }).click()
  await decision.click()
  await page.getByRole('menuitemradio', { name: 'Blocked', exact: true }).click()
  await result.click()
  await page.getByRole('menuitemradio', { name: 'Failed', exact: true }).click()

  for (const filter of [mode, decision, result]) {
    await filter.click()
    await expect(filter).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('menu')).toHaveCount(1)
    await expect(settings.locator('form [aria-haspopup=menu][aria-expanded=true]')).toHaveCount(1)
  }
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'All results', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Connected', exact: true })).toBeFocused()
  await expect(page.getByRole('menuitemradio', { name: 'Failed', exact: true })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('filter-switch.png') })

  await heading.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await mode.click()
  await page.keyboard.press('Tab')
  await expect(decision).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await decision.press('ArrowDown')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Shift+Tab')
  await expect(mode).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await result.click()
  const search = settings.getByRole('button', { name: 'Search', exact: true })
  await search.focus()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(search).toBeFocused()
  await expect(mode).toHaveText('Strict')
  await expect(decision).toHaveText('Blocked')
  await expect(result).toHaveText('Failed')
})

test('queries daily network logs on demand and confirms retention changes', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const application = (app as unknown as { application: ElectronApplication }).application
  const configRoot = await application.evaluate(() => process.env.OPEN_SCIENCE_CONFIG_ROOT!)
  expect(await realpath(configRoot)).toContain(await realpath(tmpdir()))
  const dir = join(configRoot, 'logs/network')
  await mkdir(dir, { recursive: true })
  const now = new Date().toISOString()
  const row = (mode: 'strict' | 'relaxed', run: string): NotebookNetworkAuditRecord => ({
    t: now,
    level: 'info',
    scope: 'notebook:network',
    msg: 'network access',
    data: {
      eventId: run,
      requestId: run,
      mode,
      projectId: 'audit-project',
      sessionId: 'audit-session',
      notebookRunId: run,
      runtime: 'python',
      host: 'example.org',
      port: 443,
      protocol: 'https',
      decision: 'allowed',
      outcome: 'completed',
      statusCode: 200
    }
  })
  const recentRows = [
    ...Array.from({ length: 24 }, (_, i) => row('relaxed', `run-${i + 1}`)),
    row('relaxed', 'run-relaxed'),
    row('strict', 'run-strict')
  ]
  await writeFile(
    join(dir, `notebook-${now.slice(0, 10)}.log`),
    recentRows.map((v) => JSON.stringify(v) + '\n').join('')
  )
  const older = new Date(Date.parse(now) - 9 * 86_400_000).toISOString()
  await writeFile(
    join(dir, `notebook-${older.slice(0, 10)}.log`),
    JSON.stringify({ ...row('strict', 'run-older'), t: older }) + '\n'
  )
  const page = app.page
  const settings = await openSettingsPage(page, 'Network')
  await expect(
    page.getByRole('dialog', { name: 'Notebook network logs', exact: true })
  ).toHaveCount(0)
  const access = settings.getByRole('region', { name: 'Notebook network access', exact: true })
  await access.getByRole('button', { name: 'Open', exact: true }).click()
  const logsPage = settings.getByRole('heading', {
    name: 'Notebook network logs',
    level: 1,
    exact: true
  })
  await expect(logsPage).toBeVisible()
  await expect(
    page.getByRole('dialog', { name: 'Notebook network logs', exact: true })
  ).toHaveCount(0)
  await expect(settings.getByRole('cell', { name: 'run-strict', exact: true })).toBeVisible()
  await expect(settings.getByRole('cell', { name: 'run-relaxed', exact: true })).toBeVisible()
  const advanced = settings.getByRole('button', { name: 'Advanced options' })
  const olderCell = settings.getByRole('cell', { name: 'run-older', exact: true })
  const advancedLabels = ['Address', 'Project ID', 'Session ID', 'Notebook run ID', 'From', 'To']
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  const sessionFilter = settings.getByRole('textbox', { name: 'Session ID', exact: true })
  const resultFilter = settings.getByRole('button', { name: 'Result', exact: true })
  await expect(sessionFilter).toBeHidden()
  await expect(resultFilter).toBeVisible()
  for (const label of advancedLabels)
    await expect(settings.getByLabel(label, { exact: true })).toBeHidden()
  await expect(olderCell).toHaveCount(0)
  const submit = settings.getByRole('button', { name: 'Search', exact: true })
  const splitGroup = settings.locator('[data-split-group]')
  const form = settings.locator('form')
  const expectComboActions = async (): Promise<{
    x: number
    y: number
    width: number
    height: number
  }> => {
    const [formBox, group, toggle, search] = await Promise.all([
      form.boundingBox(),
      splitGroup.boundingBox(),
      advanced.boundingBox(),
      submit.boundingBox()
    ])
    expect(toggle!.y).toBeCloseTo(search!.y, 0)
    expect(toggle!.height).toBeCloseTo(search!.height, 0)
    expect(toggle!.x).toBeGreaterThan(search!.x)
    expect(group!.width).toBeCloseTo(search!.width + toggle!.width, 0)
    expect(group!.x + group!.width).toBeCloseTo(formBox!.x + formBox!.width, 0)
    return toggle!
  }
  const retentionFilter = settings.getByRole('combobox', { name: 'Retention days', exact: true })
  const retentionLabel = settings.getByText('Retention days', { exact: true })
  const footerBox = await retentionFilter.boundingBox()
  const retentionLabelBox = await retentionLabel.boundingBox()
  expect(retentionLabelBox!.x + retentionLabelBox!.width).toBeLessThan(footerBox!.x)
  expect(retentionLabelBox!.y + retentionLabelBox!.height / 2).toBeCloseTo(
    footerBox!.y + footerBox!.height / 2,
    0
  )
  const table = settings.getByRole('table')
  const header = table.getByRole('columnheader').first()
  const headerBox = await header.boundingBox()
  expect(
    await table.evaluate((node) => {
      const viewport = node.parentElement!
      viewport.scrollTop = viewport.scrollHeight
      return viewport.scrollTop
    })
  ).toBeGreaterThan(0)
  expect(await header.boundingBox()).toEqual(headerBox)
  expect(await retentionFilter.boundingBox()).toEqual(footerBox)
  await table.evaluate((node) => {
    node.parentElement!.scrollTop = 0
  })
  await expectComboActions()
  await expect(advanced).toHaveAttribute('data-variant', 'default')
  const searchColor = await submit.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(await advanced.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    searchColor
  )
  await settings.screenshot({ path: testInfo.outputPath('network-logs.png') })
  await advanced.click()
  for (const label of advancedLabels)
    await expect(settings.getByLabel(label, { exact: true })).toBeVisible()
  const end = await settings.getByLabel('To', { exact: true }).boundingBox()
  const expandedActions = await expectComboActions()
  expect(expandedActions.y).toBeGreaterThanOrEqual(end!.y + end!.height)
  await expect(advanced).toHaveAttribute('data-variant', 'default')
  await expect(advanced).toHaveAttribute('aria-pressed', 'true')
  const activeStyle = await advanced.evaluate((element) => {
    const style = getComputedStyle(element)
    return { backgroundColor: style.backgroundColor, filter: style.filter }
  })
  expect(activeStyle.backgroundColor).toBe(searchColor)
  expect(activeStyle.filter).not.toBe('none')
  await expect(advanced.locator('svg')).toHaveAttribute('style', /transform: none/)
  await expect(advanced.locator('svg')).toHaveAttribute('style', /transition: none/)
  for (const label of ['Network mode', 'Decision', 'Result', ...advancedLabels]) {
    const box = await settings.getByLabel(label, { exact: true }).boundingBox()
    expect(box!.height).toBeCloseTo(expandedActions.height, 0)
  }
  expect((await submit.boundingBox())!.height).toBeCloseTo(expandedActions.height, 0)
  await settings.screenshot({ path: testInfo.outputPath('advanced-options.png') })
  await settings
    .getByLabel('From', { exact: true })
    .fill(new Date(Date.parse(older) - 86_400_000).toISOString().slice(0, 10) + 'T00:00')
  await sessionFilter.fill('audit-session')
  await advanced.click()
  await submit.click()
  await expect(olderCell).toBeVisible()
  await settings.getByRole('button', { name: 'Network mode', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Strict', exact: true }).click()
  await submit.click()
  await expect(settings.getByRole('cell', { name: 'run-relaxed', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('cell', { name: 'run-strict', exact: true })).toBeVisible()
  const empty = settings.getByText('No matching network records.', { exact: true })
  await advanced.click()
  await sessionFilter.fill('other-session')
  await advanced.click()
  await resultFilter.click()
  await page.getByRole('menuitemradio', { name: 'Completed', exact: true }).click()
  await submit.click()
  await expect(empty).toBeVisible()
  await advanced.click()
  await sessionFilter.fill('audit-session')
  await advanced.click()
  await submit.click()
  await expect(olderCell).toBeVisible()
  await resultFilter.click()
  await page.getByRole('menuitemradio', { name: 'Failed', exact: true }).click()
  await submit.click()
  await expect(empty).toBeVisible()
  expect(await retentionFilter.boundingBox()).toEqual(footerBox)
  await expect(settings.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await retentionFilter.click()
  await expect(page.getByRole('option')).toHaveText(['7', '15', '30', '90', '180', '365'])
  await settings.screenshot({ path: testInfo.outputPath('retention-options.png') })
  await page.getByRole('option', { name: '30', exact: true }).click()
  await expect
    .poll(() =>
      page
        .evaluate(() => window.api.network.queryNotebookLogs({}))
        .then((page) => page.retentionDays)
    )
    .toBe(30)
  await expect(retentionFilter).toHaveText('30')
  await settings.getByRole('button', { name: 'Back to network', exact: true }).click()
  await expect(access.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
  const archivePath = testInfo.outputPath('network-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, archivePath)
  const general = await openSettingsPage(page, 'General')
  await general.getByRole('button', { name: 'Export diagnostics…', exact: true }).click()
  const diagnostics = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
  const network = diagnostics.getByRole('checkbox', { name: 'Notebook network logs', exact: true })
  await expect(network).toBeEnabled()
  await expect(network).not.toBeChecked()
  const selected = diagnostics.getByRole('checkbox', { checked: true })
  while (await selected.count()) await selected.first().uncheck()
  await network.check()
  await diagnostics.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(
    diagnostics.getByText(/Diagnostic package (exported successfully|partially exported)/)
  ).toBeVisible({ timeout: 45_000 })
  const extracted = testInfo.outputPath('unpacked-network')
  await mkdir(extracted)
  await extract({ file: archivePath, cwd: extracted })
  const journal = JSON.parse(await readFile(join(extracted, 'logs/network/notebook.json'), 'utf8'))
  expect(
    journal.records.map((record: NotebookNetworkAuditRecord) => record.data.mode).sort()
  ).toEqual([...recentRows.map((record) => record.data.mode), 'strict'].sort())
  expect(journal.truncated).toBe(false)
})
