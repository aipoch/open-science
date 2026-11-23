import { expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'

test('limits image catalog refresh to official providers and saves custom model IDs', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const settings = await openSettingsPage(page, 'Model')
  await settings.locator('[data-scenario-model="image-generation"]').click()
  await settings.getByRole('button', { name: 'Image services', exact: true }).click()
  await settings.getByRole('button', { name: 'Add image service', exact: true }).click()

  const refresh = settings.getByRole('button', { name: 'Refresh model list', exact: true })
  const providerType = settings.getByRole('combobox', { name: 'Provider type', exact: true })
  const format = settings.getByRole('combobox', { name: 'API format', exact: true })
  const modelId = settings.getByLabel('Model ID', { exact: true })
  const baseUrl = 'http://127.0.0.1:9/v1'
  await settings.getByLabel('Name', { exact: true }).fill('Manual image service')
  await settings.getByLabel('Base URL', { exact: true }).fill(baseUrl)
  for (const label of ['MiniMax', 'Qwen Images', 'Seedream', 'OpenAI Images']) {
    await format.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await expect(refresh).toHaveCount(0)
    await expect(modelId).toBeEditable()
  }

  const result = await page.evaluate(
    (baseUrl) =>
      window.api.settings.refreshImageModelCatalog({
        id: crypto.randomUUID(),
        adapter: 'openai-images',
        baseUrl
      }),
    baseUrl
  )
  expect(result).toEqual({ ok: false, code: 'unsupported' })
  await modelId.fill('manual-image')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await settings.getByRole('button', { name: 'Edit Manual image service' }).click()
  await expect(modelId).toHaveValue('manual-image')
  await expect(refresh).toHaveCount(0)

  for (const vendor of ['OpenAI', 'MiniMax', 'Bailian', 'Volcengine Ark']) {
    await providerType.click()
    await page.getByRole('option', { name: vendor, exact: true }).click()
    await expect(refresh).toBeVisible()
    await expect(refresh).toBeDisabled()
    await settings.getByLabel('API key', { exact: true }).fill('synthetic-catalog-key')
    await expect(refresh).toBeEnabled()
  }
})

// Run through the real Electron IPC, network owner and repository without using account credentials.
test('accepts public catalogs and reports missing discovery prerequisites', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  const page = await app.completeOnboarding()
  const evidence = process.env.OPEN_SCIENCE_CATALOG_EVIDENCE ?? testInfo.outputPath('catalog')
  await mkdir(evidence, { recursive: true })
  const results = await page.evaluate(async () => {
    const publicCatalog = await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'opencode' }
    })
    const draftCatalog = await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'opencode', key: 'synthetic-public-catalog-key' }
    })
    const missingKey = await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'deepseek' }
    })
    const missingWorkspace = await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'bailian', region: 'china', key: 'synthetic-key' }
    })
    const unsupported = await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'zhipu', key: 'synthetic-key' }
    })
    return { publicCatalog, draftCatalog, missingKey, missingWorkspace, unsupported }
  })
  await writeFile(`${evidence}/public-results.json`, JSON.stringify(results, null, 2))
  expect(results.publicCatalog.ok).toBe(true)
  expect(results.publicCatalog.models?.length).toBeGreaterThan(0)
  expect(results.draftCatalog.ok).toBe(true)
  expect(results.missingKey).toMatchObject({ ok: false, code: 'missing-key' })
  expect(results.missingWorkspace).toMatchObject({ ok: false, code: 'missing-parameter' })
  expect(results.unsupported).toMatchObject({ ok: false, code: 'unsupported' })
  const before = await page.evaluate(() => window.api.settings.getSettings())
  expect(before.providers.some((p) => p.name === 'Catalog acceptance')).toBe(false)
  const go = results.draftCatalog as {
    draftToken: string
    catalog: { models: { id: string; routes?: Record<string, string> }[] }
  }
  expect(Object.values(go.catalog.models[0]?.routes ?? {}).length).toBeGreaterThan(0)
  const rejected = await page.evaluate(async (token) => {
    try {
      await window.api.settings.upsertProvider({
        type: 'official',
        vendorId: 'opencode',
        name: 'Wrong draft',
        key: 'changed-synthetic-key',
        catalogDraftToken: token
      })
      return false
    } catch {
      return true
    }
  }, go.draftToken)
  expect(rejected).toBe(true)
  await page.evaluate(async (token) => {
    await window.api.settings.upsertProvider({
      type: 'official',
      vendorId: 'opencode',
      name: 'Catalog acceptance',
      key: 'synthetic-public-catalog-key',
      catalogDraftToken: token
    })
  }, go.draftToken)
  const saved = await page.evaluate(() => window.api.settings.getSettings())
  const provider = saved.providers.find((p) => p.name === 'Catalog acceptance')!
  expect(provider.modelCatalog?.models.length).toBe(go.catalog.models.length)
  const settings = await openSettingsPage(page, 'Model')
  await settings
    .locator('[data-slot="settings-list-row"]')
    .filter({ hasText: 'Catalog acceptance' })
    .getByRole('button')
    .nth(1)
    .click()
  await expect(
    settings.getByRole('button', { name: 'Refresh model list', exact: true })
  ).toBeEnabled()
  await settings.getByRole('button', { name: 'Refresh model list', exact: true }).click()
  await expect(
    settings.getByText('Save to apply the refreshed model list.', { exact: true })
  ).toHaveCount(0)
  await expect(
    settings.getByRole('button', { name: 'Refresh model list', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  await expect(
    settings.getByRole('button', { name: 'Refresh model list', exact: true })
  ).toBeEnabled()
  const refreshed = await page.evaluate(() => window.api.settings.getSettings())
  expect(
    refreshed.providers.find((p) => p.name === 'Catalog acceptance')?.modelCatalog?.fetchedAt
  ).toBeGreaterThan(0)
  await settings.screenshot({ path: `${evidence}/public-refresh.png` })
  const updated = settings.getByText(/Last updated:/)
  await expect(updated).toBeVisible()
  const keyInput = settings.locator('#provider-key')
  await keyInput.fill('replacement-synthetic-key')
  await expect(updated).toHaveCount(0)
  await settings.screenshot({ path: `${evidence}/replacement-key.png` })
  await keyInput.fill('')
  await expect(updated).toBeVisible()
  await app.captureMainLog('model-catalog.log')
})

for (const [vendorId, name] of [
  ['openrouter', 'OpenRouter'],
  ['requesty', 'Requesty']
] as const) {
  test(`shows only the curated ${name} catalog and offers no online refresh`, async ({
    app
  }, testInfo) => {
    const page = await app.completeOnboarding()
    const result = await page.evaluate(
      async ({ vendorId, name }) => {
        const draft = {
          type: 'official' as const,
          vendorId,
          name,
          key: 'synthetic-local-key'
        }
        const refresh = await window.api.settings.refreshProviderModels({ draft })
        const saved = await window.api.settings.upsertProvider(draft)
        return {
          refresh,
          models: saved.providers.find((provider) => provider.vendorId === vendorId)!.models
        }
      },
      { vendorId, name }
    )
    expect(result.refresh).toMatchObject({ ok: false, code: 'unsupported' })
    const settings = await openSettingsPage(page, 'Model')
    await settings
      .locator('[data-slot="settings-list-row"]')
      .filter({ hasText: name })
      .getByRole('button')
      .nth(1)
      .click()
    await expect(settings.getByText(result.models[0], { exact: true }).first()).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Refresh model list' })).toHaveCount(0)
    await settings.screenshot({ path: testInfo.outputPath(`${vendorId}-curated.png`) })
  })
}

test('clears the previous vendor key and workspace when switching provider', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  const settings = await openSettingsPage(page, 'Model')
  await settings.locator('[data-settings-anchor="model.add-provider"]').click()
  const kind = settings.getByRole('combobox', { name: 'Provider type', exact: true })
  await kind.click()
  await page.getByRole('option', { name: 'Anthropic', exact: true }).click()
  const key = settings.getByLabel('API key', { exact: true })
  const workspace = settings.getByLabel('Workspace ID', { exact: true })
  await key.fill('synthetic-draft-key')
  await workspace.fill('previous-workspace')
  await kind.click()
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await expect(key).toHaveValue('')
  await expect(settings.getByRole('button', { name: 'Refresh model list' })).toBeDisabled()
  await kind.click()
  await page.getByRole('option', { name: 'Anthropic', exact: true }).click()
  await expect(workspace).toHaveValue('')
  await expect(key).toHaveValue('')
  await settings.screenshot({ path: testInfo.outputPath('switched-provider.png') })
})

// Real vendor acceptance: the key is supplied only by the test runner and is never persisted in
// evidence. The isolated Electron profile is discarded by the fixture after the test.
test('accepts OpenCode Go catalog with a real vendor key', async ({ app }, testInfo) => {
  const key = process.env.OPEN_SCIENCE_OPENCODE_GO_KEY
  test.skip(!key, 'Set OPEN_SCIENCE_OPENCODE_GO_KEY for the real vendor acceptance.')
  test.setTimeout(180_000)
  const page = await app.completeOnboarding()
  const evidence = process.env.OPEN_SCIENCE_CATALOG_EVIDENCE ?? testInfo.outputPath('catalog')
  await mkdir(evidence, { recursive: true })

  const result = await page.evaluate(async (vendorKey) => {
    return await window.api.settings.refreshProviderModels({
      draft: { type: 'official', vendorId: 'opencode-go', key: vendorKey }
    })
  }, key)
  await writeFile(
    `${evidence}/opencode-go-key-results.json`,
    JSON.stringify(
      {
        ok: result.ok,
        status: result.catalogStatus?.status,
        modelCount: result.models?.length,
        sample: result.catalog?.models.slice(0, 3).map((model) => ({
          id: model.id,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          supportsImageInput: model.supportsImageInput,
          supportsTools: model.supportsTools,
          supportsReasoning: model.supportsReasoning,
          routes: model.routes
        }))
      },
      null,
      2
    )
  )
  expect(result.ok).toBe(true)
  expect(result.models?.length).toBeGreaterThan(0)
  expect(Object.values(result.catalog?.models[0]?.routes ?? {}).length).toBeGreaterThan(0)
  expect(result.catalog?.models.some((model) => model.supportsImageInput)).toBe(true)

  const token = result.draftToken!
  await page.evaluate(
    async ({ vendorKey, draftToken }) => {
      await window.api.settings.upsertProvider({
        type: 'official',
        vendorId: 'opencode-go',
        name: 'OpenCode Go real acceptance',
        key: vendorKey,
        catalogDraftToken: draftToken
      })
    },
    { vendorKey: key, draftToken: token }
  )
  const saved = await page.evaluate(() => window.api.settings.getSettings())
  const provider = saved.providers.find((item) => item.name === 'OpenCode Go real acceptance')
  expect(provider?.modelCatalog?.models.length).toBe(result.catalog?.models.length)

  const settings = await openSettingsPage(page, 'Model')
  await settings
    .locator('[data-slot="settings-list-row"]')
    .filter({ hasText: 'OpenCode Go real acceptance' })
    .getByRole('button')
    .nth(1)
    .click()
  const refreshButton = settings.getByRole('button', {
    name: 'Refresh model list',
    exact: true
  })
  await expect(refreshButton).toBeEnabled()
  await refreshButton.click()
  await expect(refreshButton).toBeVisible({ timeout: 60_000 })
  await expect(refreshButton).toBeEnabled()
  await expect(
    settings.getByText('Save to apply the refreshed model list.', { exact: true })
  ).toHaveCount(0)
  await settings.screenshot({ path: `${evidence}/opencode-go-real-refresh.png` })
  await app.captureMainLog('opencode-go-real-acceptance.log')
})
