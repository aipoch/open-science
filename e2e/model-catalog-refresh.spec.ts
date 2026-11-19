import { expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from './fixtures/electron-app'
import { openSettingsPage } from './fixtures/settings-preferences'

test('refreshes a custom image service without submitting a generation', async ({ app }) => {
  const token = 'synthetic-image-catalog-key'
  const requests: Array<{ method?: string; path?: string; authorization?: string }> = []
  let rejectCatalog = false
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization
    })
    response.writeHead(rejectCatalog ? 401 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'fixture-image' }, { id: 'second-image' }] }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const page = await app.completeOnboarding()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    const settings = await openSettingsPage(page, 'Model')
    await settings.locator('[data-scenario-model="image-generation"]').click()
    await settings.getByRole('button', { name: 'Image services', exact: true }).click()
    await settings.getByRole('button', { name: 'Add image service', exact: true }).click()
    await settings.getByLabel('Name', { exact: true }).fill('Catalog image service')
    await settings.getByLabel('Base URL', { exact: true }).fill(`${baseUrl}/v1`)
    await settings.getByLabel('API key', { exact: true }).fill(token)

    const refresh = settings.getByRole('button', { name: 'Refresh model list', exact: true })
    const discovered = settings.getByRole('combobox', {
      name: 'Choose a server model that supports image generation.'
    })
    await refresh.click()
    await discovered.click()
    await page.getByRole('option', { name: 'fixture-image', exact: true }).click()
    await expect(settings.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-image')
    expect(await page.evaluate(() => window.api.settings.getImageModels())).toMatchObject({
      services: []
    })
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
    await settings.getByRole('button', { name: 'Edit Catalog image service' }).click()

    rejectCatalog = true
    await refresh.click()
    await expect(
      settings.getByText('Model refresh failed. The previous list is kept.')
    ).toBeVisible()
    await expect(settings.getByLabel('Model ID', { exact: true })).toHaveValue('fixture-image')
    rejectCatalog = false
    await settings.getByLabel('Base URL', { exact: true }).fill(`${baseUrl}/other/v1`)
    await refresh.click()
    await expect(discovered).toBeVisible()
    expect(requests).toEqual([
      { method: 'GET', path: '/v1/models', authorization: `Bearer ${token}` },
      { method: 'GET', path: '/v1/models', authorization: `Bearer ${token}` },
      { method: 'GET', path: '/other/v1/models', authorization: undefined }
    ])

    const restarted = await app.restart()
    const persisted = await restarted.evaluate(() => window.api.settings.getImageModels())
    expect(persisted.services).toHaveLength(1)
    const [service] = persisted.services
    expect(service).toMatchObject({
      baseUrl: `${baseUrl}/v1`,
      models: [{ wireModelId: 'fixture-image', presetId: 'openai-images/generic' }]
    })
    expect(persisted.imageModel).toEqual({ serviceId: service.id, modelId: service.models[0].id })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
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
