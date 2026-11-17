import { expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'

// Run through the real Electron IPC, network owner and repository without using account credentials.
test('refreshes public catalogs and keeps draft results isolated until save', async ({ app }, testInfo) => {
  test.setTimeout(180_000)
  const page = await app.completeOnboarding()
  const evidence = process.env.OPEN_SCIENCE_CATALOG_EVIDENCE ?? testInfo.outputPath('catalog')
  await mkdir(evidence, { recursive: true })
  const results = await page.evaluate(async () => {
    const results: unknown[] = []
    for (const vendorId of ['opencode'] as const) {
      const result = await window.api.settings.refreshProviderModels({ draft: { type: 'official', vendorId, key: 'synthetic-public-catalog-key' } })
      results.push({ vendorId, ...result })
    }
    return results
  })
  await writeFile(`${evidence}/public-results.json`, JSON.stringify(results, null, 2))
  for (const result of results as { vendorId: string; ok: boolean; models?: string[] }[]) {
    expect(result.ok, result.vendorId).toBe(true)
    expect(result.models!.length, result.vendorId).toBeGreaterThan(0)
  }
  const before = await page.evaluate(() => window.api.settings.getSettings())
  expect(before.providers.some((p) => p.name === 'Catalog acceptance')).toBe(false)
  const go = results[0] as { draftToken: string; catalog: { models: { id: string; routes?: Record<string, string> }[] } }
  expect(Object.values(go.catalog.models[0]?.routes ?? {}).length).toBeGreaterThan(0)
  const rejected = await page.evaluate(async (token) => {
    try {
      await window.api.settings.upsertProvider({ type: 'official', vendorId: 'opencode', name: 'Wrong draft', key: 'changed-synthetic-key', catalogDraftToken: token })
      return false
    } catch { return true }
  }, go.draftToken)
  expect(rejected).toBe(true)
  await page.evaluate(async (token) => {
    await window.api.settings.upsertProvider({ type: 'official', vendorId: 'opencode', name: 'Catalog acceptance', key: 'synthetic-public-catalog-key', catalogDraftToken: token })
  }, go.draftToken)
  const saved = await page.evaluate(() => window.api.settings.getSettings())
  const provider = saved.providers.find((p) => p.name === 'Catalog acceptance')!
  expect(provider.modelCatalog?.models.length).toBe(go.catalog.models.length)
  const settings = await openSettingsPage(page, 'Model')
  await settings.locator('[data-slot="settings-list-row"]').filter({ hasText: 'Catalog acceptance' }).getByRole('button').nth(1).click()
  await expect(settings.getByRole('button', { name: 'Refresh from vendor', exact: true })).toBeEnabled()
  await settings.getByRole('button', { name: 'Refresh from vendor', exact: true }).click()
  await expect(settings.getByText('Save to apply the refreshed model list.', { exact: true })).toBeVisible()
  await settings.screenshot({ path: `${evidence}/public-refresh.png` })
  await app.captureMainLog('model-catalog.log')
})
