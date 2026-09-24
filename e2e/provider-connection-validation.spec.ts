import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import type { SettingsSnapshot } from '../src/shared/settings'

const PROVIDER_NAME = 'Connection validation E2E'
const SYNTHETIC_KEY = 'sk-e2e-connection-validation-only'

type Probe = { model: unknown; authorization?: string; path?: string }

const openModelSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /^(Model settings|Settings)$/ }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  const navigation = settings.getByRole('navigation', { name: 'Settings', exact: true })
  if (!(await navigation.isVisible())) {
    await settings.getByRole('button', { name: 'Open settings navigation' }).click()
  }
  await navigation.getByRole('button', { name: 'Model', exact: true }).click()
  return settings
}

const snapshot = (page: Page): Promise<SettingsSnapshot> =>
  page.evaluate(() => window.api.settings.getSettings())

// The shared fixture creates independent mkdtemp Electron profile and storage directories.
// Only the loopback server below receives credentials; all responses and keys are synthetic.
test('tests current provider input and commits only verified configurations', async ({
  app
}, testInfo) => {
  let acceptsConnection = false
  const probes: Probe[] = []
  const gateway = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
      probes.push({
        model: body.model,
        authorization: request.headers.authorization,
        path: request.url
      })
      response.writeHead(acceptsConnection ? 200 : 401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          acceptsConnection
            ? {
                id: 'msg_e2e',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 }
              }
            : { error: { type: 'authentication_error', message: 'Synthetic key rejected.' } }
        )
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    gateway.once('error', reject)
    gateway.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
  try {
    const page = await app.completeOnboarding()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    let settings = await openModelSettings(page)
    await settings.locator('[data-settings-anchor="model.add-provider"]').click()
    await settings.getByRole('combobox', { name: 'Provider type', exact: true }).click()
    await page.getByRole('option', { name: 'Custom Gateway', exact: true }).click()
    await settings.getByRole('textbox', { name: 'Provider name', exact: true }).fill(PROVIDER_NAME)
    await settings.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
    await settings.getByRole('combobox', { name: 'API format', exact: true }).click()
    await page
      .getByRole('option', {
        name: 'Messages (/v1/messages) — Claude / Anthropic-compatible',
        exact: true
      })
      .click()
    await settings.getByLabel('API key', { exact: true }).fill(SYNTHETIC_KEY)
    await settings.getByRole('textbox', { name: 'Model', exact: true }).fill('original-model')

    const footer = settings.locator('[data-slot="provider-form-footer"]')
    const testConnection = footer.getByRole('button', { name: 'Test connection', exact: true })
    const save = footer.getByRole('button', { name: 'Save', exact: true })
    const scroller = settings.locator('[data-slot="settings-content-scroll"]')
    // Assert the actual control stays on screen across a long form, without Playwright auto-scroll.
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(testConnection).toBeInViewport()
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(testConnection).toBeInViewport()
    await testConnection.click()
    await expect(
      settings.getByText('Authentication failed. Check the API key.', { exact: true })
    ).toBeVisible()
    await expect(settings.getByText('Changes have not been saved.', { exact: true })).toBeVisible()
    await expect(settings.getByRole('textbox', { name: 'Model', exact: true })).toHaveValue(
      'original-model'
    )
    const details = settings.locator('details').filter({ hasText: 'View details' })
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open', '')
    await expect(details.locator('p')).toContainText('401')
    await expect(testConnection).toBeInViewport()
    await expect(save).toBeInViewport()
    const errorScreenshot = testInfo.outputPath('provider-connection-error.png')
    await settings.screenshot({ path: errorScreenshot })
    await testInfo.attach('provider-connection-error', {
      path: errorScreenshot,
      contentType: 'image/png'
    })
    expect(
      (await snapshot(page)).providers.some((provider) => provider.name === PROVIDER_NAME)
    ).toBe(false)

    const requestsBeforeFailedSave = probes.length
    await save.click()
    await expect(testConnection).toBeEnabled()
    await expect.poll(() => probes.length).toBeGreaterThan(requestsBeforeFailedSave)
    expect(
      (await snapshot(page)).providers.some((provider) => provider.name === PROVIDER_NAME)
    ).toBe(false)
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue(SYNTHETIC_KEY)

    acceptsConnection = true
    await testConnection.click()
    await expect(settings.getByText('Connection succeeded.', { exact: true })).toBeVisible()
    expect(
      (await snapshot(page)).providers.some((provider) => provider.name === PROVIDER_NAME)
    ).toBe(false)
    await save.click()
    await expect(settings.locator('[data-settings-anchor="model.add-provider"]')).toBeVisible()
    const saved = (await snapshot(page)).providers.find(
      (provider) => provider.name === PROVIDER_NAME
    )!
    expect(saved).toMatchObject({ model: 'original-model', baseUrl, hasKey: true })
    expect(saved.lastValidatedAt).toBeDefined()
    await page.evaluate(({ id, model }) => window.api.settings.setActiveProvider({ id, model }), {
      id: saved.id,
      model: 'original-model'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    settings = await openModelSettings(page)
    const row = settings
      .locator('[data-slot="settings-list-row"]')
      .filter({ hasText: PROVIDER_NAME })
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
    await expect(settings.getByLabel('API key', { exact: true })).toHaveAttribute(
      'placeholder',
      /leave blank to keep/
    )
    await settings.getByRole('textbox', { name: 'Model', exact: true }).fill('replacement-model')
    acceptsConnection = false
    const editFooter = settings.locator('[data-slot="provider-form-footer"]')
    await editFooter.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(
      settings.getByText('Authentication failed. Check the API key.', { exact: true })
    ).toBeVisible()
    await editFooter.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      editFooter.getByRole('button', { name: 'Test connection', exact: true })
    ).toBeEnabled()
    const rejectedEdit = await snapshot(page)
    expect(rejectedEdit.providers.find((provider) => provider.id === saved.id)).toMatchObject({
      model: 'original-model',
      configRevision: saved.configRevision,
      maskedKey: saved.maskedKey,
      lastValidatedAt: saved.lastValidatedAt
    })
    expect(rejectedEdit).toMatchObject({
      activeProviderId: saved.id,
      activeModel: 'original-model'
    })
    await expect(settings.getByRole('textbox', { name: 'Model', exact: true })).toHaveValue(
      'replacement-model'
    )
    expect(probes.at(-1)).toMatchObject({
      model: 'replacement-model',
      authorization: `Bearer ${SYNTHETIC_KEY}`,
      path: '/v1/messages'
    })

    acceptsConnection = true
    await editFooter.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings.locator('[data-settings-anchor="model.add-provider"]')).toBeVisible()
    const updated = await snapshot(page)
    expect(updated.providers.find((provider) => provider.id === saved.id)).toMatchObject({
      model: 'replacement-model',
      hasKey: true
    })
    expect(updated).toMatchObject({ activeProviderId: saved.id, activeModel: 'replacement-model' })
    expect(probes.every((probe) => probe.authorization === `Bearer ${SYNTHETIC_KEY}`)).toBe(true)
    expect(probes.some((probe) => probe.model === 'original-model')).toBe(true)
    expect(probes.some((probe) => probe.model === 'replacement-model')).toBe(true)
    const savedScreenshot = testInfo.outputPath('provider-connection-saved.png')
    await settings.screenshot({ path: savedScreenshot })
    await testInfo.attach('provider-connection-saved', {
      path: savedScreenshot,
      contentType: 'image/png'
    })
  } finally {
    gateway.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      gateway.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

// A controlled ACP process sends a real HTTP request through the app-owned bridge. The upstream
// is synthetic; the runtime error, settings event, and already-mounted Settings UI are production.
for (const upstreamStatus of [401, 403]) {
  test(`synchronizes a conversation upstream ${upstreamStatus} into the open provider settings`, async ({
    app
  }, testInfo) => {
    let rejectRuntime = false
    let rejectPendingRequest: (() => void) | undefined
    const probes: Probe[] = []
    const gateway = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
        probes.push({
          model: body.model,
          authorization: request.headers.authorization,
          path: request.url
        })
        if (rejectRuntime) {
          rejectPendingRequest = () => {
            if (response.writableEnded || response.destroyed) return
            response.writeHead(upstreamStatus, { 'content-type': 'application/json' })
            response.end(
              JSON.stringify({
                error: { type: 'authentication_error', message: 'Synthetic runtime key rejected.' }
              })
            )
          }
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
          })
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      gateway.once('error', reject)
      gateway.listen(0, '127.0.0.1', resolve)
    })
    const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
    try {
      await app.completeOnboarding()
      const page = await app.configureFakeAgent()
      const providerId = await page.evaluate(
        async ({ baseUrl, key }) => {
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          const result = await window.api.settings.saveValidatedProvider({
            name: 'Runtime health E2E',
            type: 'custom',
            baseUrl,
            key,
            model: 'runtime-health-model',
            apiEndpoints: ['openai']
          })
          if (!result.providerId)
            throw new Error('The synthetic runtime provider failed validation.')
          await window.api.settings.setActiveProvider({
            id: result.providerId,
            model: 'runtime-health-model'
          })
          return result.providerId
        },
        { baseUrl, key: SYNTHETIC_KEY }
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      await createProject(page, 'Provider health synchronization')
      await page.evaluate((id) => {
        const evidence: { failure?: string } = {}
        Object.assign(window, { providerHealthEvidence: evidence })
        window.api.settings.onChanged((settings) => {
          const provider = settings.providers.find((item) => item.id === id)
          if (provider?.lastValidationFailure)
            evidence.failure = provider.lastValidationFailure.category
        })
      }, providerId)
      rejectRuntime = true
      await page
        .getByRole('textbox', { name: 'Ask anything' })
        .fill('Verify runtime provider failure synchronization.')
      await page.getByRole('button', { name: 'Send message' }).click()
      await expect.poll(() => Boolean(rejectPendingRequest)).toBe(true)
      const settings = await openModelSettings(page)
      const row = settings
        .locator('[data-slot="settings-list-row"]')
        .filter({ hasText: 'Runtime health E2E' })
      await expect(row.getByLabel('Connection verified', { exact: true })).toBeVisible()
      rejectPendingRequest!()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  providerHealthEvidence: { failure?: string }
                }
              ).providerHealthEvidence
          )
        )
        .toMatchObject({ failure: 'auth' })
      // No reload, reopening, or snapshot read triggers this UI update: it comes from settings:changed.
      await expect(row.getByLabel('Connection verified', { exact: true })).toHaveCount(0)
      await expect(
        row.getByLabel('Test failed: authentication rejected — check the API key.', { exact: true })
      ).toBeVisible()
      const current = (await snapshot(page)).providers.find(
        (provider) => provider.id === providerId
      )!
      expect(current.lastValidationFailure).toMatchObject({
        category: 'auth',
        status: upstreamStatus
      })
      expect(current.lastValidatedAt).toBeUndefined()
      expect(probes.at(-1)).toMatchObject({
        model: 'runtime-health-model',
        authorization: `Bearer ${SYNTHETIC_KEY}`,
        path: '/v1/chat/completions'
      })
      await row.scrollIntoViewIfNeeded()
      const screenshot = testInfo.outputPath('provider-runtime-failure-synchronized.png')
      await settings.screenshot({ path: screenshot })
      await testInfo.attach('provider-runtime-failure-synchronized', {
        path: screenshot,
        contentType: 'image/png'
      })
      await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
      await expect(page.getByText('Session status: Error', { exact: true })).toBeAttached()
    } finally {
      rejectPendingRequest?.()
      gateway.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
}

for (const action of ['Test connection', 'Save']) {
  test(`${action} marks the unchanged saved connection unavailable after 403 without saving rejected edits`, async ({
    app
  }, testInfo) => {
    let acceptsSavedKey = true
    const probes: Probe[] = []
    const gateway = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
        probes.push({
          model: body.model,
          authorization: request.headers.authorization,
          path: request.url
        })
        const accepted =
          acceptsSavedKey && request.headers.authorization === `Bearer ${SYNTHETIC_KEY}`
        response.writeHead(accepted ? 200 : 403, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            accepted
              ? {
                  id: 'msg_e2e',
                  type: 'message',
                  role: 'assistant',
                  model: body.model,
                  content: [{ type: 'text', text: 'OK' }],
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 }
                }
              : { error: { type: 'permission_error', message: 'Synthetic access denied.' } }
          )
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      gateway.once('error', reject)
      gateway.listen(0, '127.0.0.1', resolve)
    })
    const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
    try {
      const page = await app.completeOnboarding()
      const providerId = await page.evaluate(
        async ({ baseUrl, key }) => {
          await window.api.locale.setPreference({ preference: 'en' })
          const result = await window.api.settings.saveValidatedProvider({
            type: 'custom',
            name: 'Saved connection 403 E2E',
            baseUrl,
            key,
            apiEndpoints: ['anthropic'],
            model: 'saved-model'
          })
          if (!result.providerId) throw new Error('Synthetic saved provider did not validate.')
          await window.api.settings.setActiveProvider({
            id: result.providerId,
            model: 'saved-model'
          })
          return result.providerId
        },
        { baseUrl, key: SYNTHETIC_KEY }
      )
      await page.reload({ waitUntil: 'domcontentloaded' })
      const before = (await snapshot(page)).providers.find(
        (provider) => provider.id === providerId
      )!
      expect(before.lastValidatedAt).toBeDefined()
      const settings = await openModelSettings(page)
      const row = settings
        .locator('[data-slot="settings-list-row"]')
        .filter({ hasText: 'Saved connection 403 E2E' })
      await expect(row.getByLabel('Connection verified', { exact: true })).toBeVisible()
      await row.getByRole('button', { name: 'Edit', exact: true }).click()
      const footer = settings.locator('[data-slot="provider-form-footer"]')
      const submit = footer.getByRole('button', { name: action, exact: true })
      const testConnection = footer.getByRole('button', { name: 'Test connection', exact: true })
      const key = settings.getByLabel('API key', { exact: true })
      await key.fill('sk-e2e-invalid-candidate')
      await submit.click()
      await expect(
        settings.getByText('Authentication failed. Check the API key.', { exact: true })
      ).toBeVisible()
      await expect(testConnection).toBeEnabled()
      const candidateRejected = (await snapshot(page)).providers.find(
        (provider) => provider.id === providerId
      )!
      expect(candidateRejected).toMatchObject({
        model: before.model,
        baseUrl: before.baseUrl,
        maskedKey: before.maskedKey,
        configRevision: before.configRevision,
        lastValidatedAt: before.lastValidatedAt
      })
      expect(candidateRejected.lastValidationFailure).toBeUndefined()
      expect(probes.at(-1)?.authorization).toBe('Bearer sk-e2e-invalid-candidate')

      // The next failure is against the persisted connection itself, not the rejected replacement.
      await key.fill('')
      acceptsSavedKey = false
      await submit.click()
      await expect(
        settings.getByText('Authentication failed. Check the API key.', { exact: true })
      ).toBeVisible()
      await expect(testConnection).toBeEnabled()
      await expect
        .poll(
          async () =>
            (await snapshot(page)).providers.find((provider) => provider.id === providerId)
              ?.lastValidationFailure
        )
        .toMatchObject({ category: 'auth', status: 403 })
      const failed = await snapshot(page)
      const unchanged = failed.providers.find((provider) => provider.id === providerId)!
      expect(unchanged).toMatchObject({
        model: before.model,
        baseUrl: before.baseUrl,
        maskedKey: before.maskedKey,
        configRevision: before.configRevision
      })
      expect(unchanged.lastValidatedAt).toBeUndefined()
      expect(failed).toMatchObject({ activeProviderId: providerId, activeModel: 'saved-model' })
      expect(probes.at(-1)?.authorization).toBe(`Bearer ${SYNTHETIC_KEY}`)
      await footer.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(row.getByLabel('Connection verified', { exact: true })).toHaveCount(0)
      await expect(row.getByLabel(/Test failed:/)).toBeVisible()
      await row.scrollIntoViewIfNeeded()
      const screenshot = testInfo.outputPath('saved-provider-403-unavailable.png')
      await settings.screenshot({ path: screenshot })
      await testInfo.attach('saved-provider-403-unavailable', {
        path: screenshot,
        contentType: 'image/png'
      })

      // A fresh successful verification can restore the same persisted connection.
      acceptsSavedKey = true
      await row.getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(settings.getByLabel('API key', { exact: true })).toHaveValue('')
      await settings
        .locator('[data-slot="provider-form-footer"]')
        .getByRole('button', { name: 'Save', exact: true })
        .click()
      await expect(settings.locator('[data-settings-anchor="model.add-provider"]')).toBeVisible()
      await expect(row.getByLabel('Connection verified', { exact: true })).toBeVisible()
      await expect(row.getByLabel(/Test failed:/)).toHaveCount(0)
      const recovered = await snapshot(page)
      const recoveredProvider = recovered.providers.find((provider) => provider.id === providerId)!
      expect(recoveredProvider).toMatchObject({
        model: before.model,
        baseUrl: before.baseUrl,
        maskedKey: before.maskedKey
      })
      expect(recoveredProvider.lastValidationFailure).toBeUndefined()
      expect(recoveredProvider.lastValidatedAt).toBeGreaterThan(before.lastValidatedAt!)
      expect(recovered).toMatchObject({ activeProviderId: providerId, activeModel: 'saved-model' })
      expect(probes.at(-1)).toMatchObject({
        model: 'saved-model',
        authorization: `Bearer ${SYNTHETIC_KEY}`,
        path: '/v1/messages'
      })
    } finally {
      gateway.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
}
