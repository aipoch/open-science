import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SettingsSnapshot } from '../src/shared/settings'
import { networkInterfaces } from 'node:os'
import { expect } from '@playwright/test'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'

const privateHost = () =>
  Object.values(networkInterfaces())
    .flat()
    .find(
      (address) =>
        address?.family === 'IPv4' &&
        !address.internal &&
        /^(192\.168\.|10\.)/.test(address.address)
    )?.address

const startModelServer = async (host: string) => {
  let probes = 0
  const server = createServer(async (req, res) => {
    probes++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
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
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://${host}:${port}`,
    port,
    get requests() {
      return probes
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('enforces a saved HTTP model grant and explains revocation across restart', async ({
  app
}) => {
  test.setTimeout(180_000)
  const host = privateHost()
  test.skip(!host, 'A private non-loopback interface is required for the remote HTTP policy.')
  const server = await startModelServer(host!)
  try {
    const { port } = server
    const edit = {
      type: 'custom' as const,
      name: 'HTTP fixture',
      baseUrl: server.baseUrl,
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
    expect(server.requests).toBeGreaterThanOrEqual(2)
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
    const beforeDenial = server.requests
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
    expect(server.requests).toBe(beforeDenial)
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
    await server.close()
  }
})

test('shows the local denial when an existing conversation switches to an untrusted HTTP provider', async ({
  app
}) => {
  const host = privateHost()
  test.skip(!host, 'A private non-loopback interface is required for the remote HTTP policy.')
  const local = await startModelServer('127.0.0.1')
  try {
    const remote = await startModelServer(host!)
    try {
      const page = await app.completeOnboarding()
      const remoteModel = 'remote-switch-model'
      const remoteProviderId = await page.evaluate(
        async ({ localUrl, remoteUrl, remoteModel }) => {
          const settings = window.api.settings
          const common = {
            type: 'custom' as const,
            key: 'synthetic-test-only',
            apiEndpoints: ['messages' as const]
          }
          const local = await settings.saveValidatedProvider({
            ...common,
            name: 'Loopback fixture',
            baseUrl: localUrl,
            model: 'local-switch-model'
          })
          const remote = await settings.saveValidatedProvider({
            ...common,
            name: 'Remote fixture',
            baseUrl: remoteUrl,
            model: remoteModel
          })
          if (!local.providerId || !remote.providerId)
            throw new Error('Model fixtures failed validation')
          await settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          await settings.setActiveProvider({ id: local.providerId, model: 'local-switch-model' })
          await settings.setAgentFramework({ id: 'open-science-agent' })
          const policy = (await settings.getSettings()).notebookNetwork!
          await settings.setNotebookNetwork({
            allowedDomains: policy.allowedDomains,
            disabledOpenScienceDomains: policy.disabledOpenScienceDomains,
            disabledOpenScienceDomainGroups: policy.disabledOpenScienceDomainGroups,
            baseTrustedPrivateDestinations: policy.trustedPrivateDestinations,
            trustedPrivateDestinations: []
          })
          return remote.providerId
        },
        { localUrl: local.baseUrl, remoteUrl: remote.baseUrl, remoteModel }
      )

      const projectId = await createProject(page, 'HTTP provider switch')
      await submitPromptViaUi(page, 'Reply before switching models.')
      await expect(page.getByText('ALLOWLIST_FIXTURE_OK', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
      const sessionId = await page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find(
            (session) => session.projectId === id
          )!.id,
        projectId
      )
      const requestsBeforeSwitch = remote.requests
      await page.getByRole('button', { name: 'Select model', exact: true }).click()
      await page.getByTestId('model-row').hover()
      await page.getByRole('menuitemradio', { name: remoteModel, exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id)
                ?.agentConfiguration,
            sessionId
          )
        )
        .toMatchObject({ providerId: remoteProviderId, model: remoteModel })
      await submitPromptViaUi(page, 'Continue after switching models.')
      const notice = page
        .getByTestId('conversation-composer-dock')
        .getByTestId('composer-notice-slot')
      await expect(
        notice.getByRole('heading', { name: 'Model request blocked', exact: true })
      ).toBeVisible()
      await notice.locator('summary').click()
      await expect(notice.locator('pre')).toContainText('MODEL_HTTP_DESTINATION_NOT_ALLOWED')
      expect(remote.requests).toBe(requestsBeforeSwitch)
    } finally {
      await remote.close()
    }
  } finally {
    await local.close()
  }
})
