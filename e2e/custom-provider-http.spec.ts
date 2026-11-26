import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SettingsSnapshot } from '../src/shared/settings'
import { networkInterfaces } from 'node:os'
import { expect } from '@playwright/test'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'

test('enforces a saved HTTP model grant and explains revocation across restart', async ({
  app
}) => {
  test.setTimeout(180_000)
  const host = Object.values(networkInterfaces())
    .flat()
    .find(
      (address) =>
        address?.family === 'IPv4' &&
        !address.internal &&
        /^(192\.168\.|10\.)/.test(address.address)
    )?.address
  test.skip(!host, 'A private non-loopback interface is required for the remote HTTP policy.')
  let probes = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    probes++
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ALLOWLIST_FIXTURE_OK' }
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' }
      ]
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  try {
    const port = (server.address() as AddressInfo).port
    const edit = {
      type: 'custom' as const,
      name: 'HTTP fixture',
      baseUrl: `http://${host}:${port}`,
      model: 'mock-model',
      key: 'synthetic-test-only',
      apiEndpoints: ['messages' as const]
    }
    let page = await app.completeOnboarding()
    const inspect = (): Promise<SettingsSnapshot> =>
      page.evaluate(() => window.api.settings.getSettings())
    const testResult = await page.evaluate(
      (edit) => window.api.settings.validateProvider({ edit }),
      edit
    )
    expect(testResult.ok, JSON.stringify(testResult)).toBe(true)
    expect((await inspect()).notebookNetwork?.trustedPrivateDestinations ?? []).toHaveLength(0)
    const saved = await page.evaluate(
      (edit) => window.api.settings.saveValidatedProvider(edit),
      edit
    )
    expect(saved.validation.ok, JSON.stringify(saved.validation)).toBe(true)
    expect(probes).toBeGreaterThanOrEqual(2)
    const granted = (await inspect()).notebookNetwork?.trustedPrivateDestinations
    expect(granted).toEqual([expect.objectContaining({ hostname: host, port, protocol: 'http' })])
    await page.evaluate(
      async ({ id, model }) => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        await window.api.settings.setActiveProvider({ id, model })
        await window.api.settings.setAgentFramework({ id: 'open-science-agent' })
      },
      { id: saved.providerId!, model: edit.model }
    )
    const project = 'HTTP allowlist'
    const prompt = 'Reply briefly without tools.'
    await createProject(page, project)
    await submitPromptViaUi(page, prompt)
    await expect(page.getByText('ALLOWLIST_FIXTURE_OK', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await page.evaluate(async () => {
      const current = (await window.api.settings.getSettings()).notebookNetwork!
      await window.api.settings.setNotebookNetwork({
        allowedDomains: current.allowedDomains,
        disabledOpenScienceDomains: current.disabledOpenScienceDomains,
        disabledOpenScienceDomainGroups: current.disabledOpenScienceDomainGroups,
        baseTrustedPrivateDestinations: current.trustedPrivateDestinations,
        trustedPrivateDestinations: []
      })
    })
    const beforeDenial = probes
    const assertNotice = async (): Promise<void> => {
      const notice = page
        .getByTestId('conversation-composer-dock')
        .getByTestId('composer-notice-slot')
      await expect(
        notice.getByRole('heading', { name: 'Model request blocked', exact: true })
      ).toBeVisible({ timeout: 30_000 })
      await expect(notice).toContainText('Saving grants both the Agent and Notebook access')
      await expect(notice.locator('[data-notice-action]')).toHaveCount(0)
      await expect(notice.getByRole('button', { name: 'Dismiss error' })).toBeVisible()
      await notice.locator('summary').click()
      await expect(notice.locator('pre')).toContainText('MODEL_HTTP_DESTINATION_NOT_ALLOWED')
    }
    await submitPromptViaUi(page, 'Reply again after revocation.')
    await assertNotice()
    page = await app.restart()
    await openProjectSession(page, project, prompt)
    await assertNotice()
    const startCleanConversation = async (): Promise<void> => {
      await page.getByRole('button', { name: 'New', exact: true }).click()
      await expect(
        page.getByText('What would you like to research?', { exact: true })
      ).toBeVisible()
      await expect(page.getByTestId('composer-notice-slot')).toHaveCount(0)
    }
    await startCleanConversation()
    const blockedPrompt = 'Start a new conversation after revocation.'
    await submitPromptViaUi(page, blockedPrompt)
    await assertNotice()
    await startCleanConversation()
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .locator('button[data-slot="session-open-button"]')
      .filter({ hasText: blockedPrompt.slice(0, 36) })
      .click()
    await assertNotice()
    expect(probes).toBe(beforeDenial)
    const restored = await page.evaluate(
      (edit) => window.api.settings.saveValidatedProvider(edit),
      { ...edit, id: saved.providerId! }
    )
    expect(restored.validation.ok).toBe(true)
    await submitPromptViaUi(page, 'Reply after authorization is restored.')
    await expect(page.getByText('ALLOWLIST_FIXTURE_OK', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await page.evaluate((id) => window.api.settings.deleteProvider({ id }), saved.providerId!)
    expect((await inspect()).notebookNetwork?.trustedPrivateDestinations).toEqual(granted)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
