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
  await writeFile(
    join(dir, `notebook-${now.slice(0, 10)}.log`),
    [row('relaxed', 'run-relaxed'), row('strict', 'run-strict')]
      .map((v) => JSON.stringify(v) + '\n')
      .join('')
  )
  const page = app.page
  const settings = await openSettingsPage(page, 'Network')
  await expect(
    page.getByRole('dialog', { name: 'Notebook network logs', exact: true })
  ).toHaveCount(0)
  await settings.getByRole('button', { name: 'Notebook network logs', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Notebook network logs', exact: true })
  await expect(dialog.getByRole('cell', { name: 'run-strict', exact: true })).toBeVisible()
  await expect(dialog.getByRole('cell', { name: 'run-relaxed', exact: true })).toBeVisible()
  await dialog.getByLabel('Network mode', { exact: true }).selectOption('strict')
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog.getByRole('cell', { name: 'run-relaxed', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('cell', { name: 'run-strict', exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Retention days', exact: true }).fill('30')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Shorten network log retention?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await page.evaluate(() => window.api.network.queryNotebookLogs({}))).retentionDays).toBe(
    90
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(confirmation).toBeHidden()
  expect((await page.evaluate(() => window.api.network.queryNotebookLogs({}))).retentionDays).toBe(
    30
  )
  await dialog.screenshot({ path: testInfo.outputPath('network-logs.png') })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    settings.getByRole('button', { name: 'Notebook network logs', exact: true })
  ).toBeFocused()
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
  ).toEqual(['relaxed', 'strict'])
  expect(journal.truncated).toBe(false)
})
