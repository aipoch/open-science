import type { UpsertProviderRequest } from '../src/shared/settings'
import type { TrustedPrivateDestination } from '../src/shared/notebook-network-settings'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { openSettingsPage } from './fixtures/settings-preferences'
import { networkInterfaces } from 'node:os'
import { expect } from '@playwright/test'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'

const nonLoopbackHost = (): string => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)
  if (!address)
    throw new Error('The HTTP model fixture requires a local non-loopback IPv4 interface.')
  return address.address
}

type ModelServer = {
  baseUrl: string
  port: number
  readonly requests: number
  close: () => Promise<void>
}

const startModelServer = async (host: string): Promise<ModelServer> => {
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

const assertNotice = async (page: Page): Promise<void> => {
  const notice = page.getByTestId('conversation-composer-dock').getByTestId('composer-notice-slot')
  await expect(
    notice.getByRole('heading', { name: 'Model request blocked', exact: true })
  ).toBeVisible()
  await expect(notice).toContainText('Saving grants both the Agent and Notebook access')
  await expect(notice.locator('[data-notice-action]')).toHaveCount(0)
  await expect(notice.getByRole('button', { name: 'Dismiss error' })).toBeVisible()
  await notice.locator('summary').click()
  await expect(notice.locator('pre')).toContainText('MODEL_HTTP_DESTINATION_NOT_ALLOWED')
}

test('explains shared HTTP access in the provider form and grants it only on save @pr-mainline-conversation', async ({
  app
}) => {
  const host = nonLoopbackHost()
  const server = await startModelServer(host)
  try {
    const page = await app.completeOnboarding()
    const grants = async (): Promise<readonly TrustedPrivateDestination[]> =>
      (await page.evaluate(() => window.api.settings.getSettings())).notebookNetwork
        ?.trustedPrivateDestinations ?? []
    const settings = await openSettingsPage(page, 'Model')
    await settings.locator('[data-settings-anchor="model.add-provider"]').click()
    await settings.locator('[data-provider-kind="custom"]').click()
    await settings.getByRole('textbox', { name: 'Provider name', exact: true }).fill('HTTP fixture')
    await settings.getByRole('textbox', { name: 'Base URL', exact: true }).fill(server.baseUrl)
    await expect(
      settings.getByText(
        'Remote HTTP model endpoints are shared with Agent & Notebook network after you save this model. API keys and model traffic are not encrypted in transit.',
        { exact: true }
      )
    ).toBeVisible()
    await settings.getByRole('combobox', { name: 'API format', exact: true }).click()
    await page
      .getByRole('option', {
        name: 'Messages (/v1/messages) — Claude / Anthropic-compatible',
        exact: true
      })
      .click()
    await settings.getByLabel('API key', { exact: true }).fill('synthetic-test-only')
    await settings.getByRole('textbox', { name: 'Model', exact: true }).fill('mock-model')
    const footer = settings.locator('[data-slot="provider-form-footer"]')
    await footer.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(settings.getByText('Connection succeeded.', { exact: true })).toBeVisible()
    const probes = server.requests
    expect(probes).toBeGreaterThan(0)
    expect(await grants()).toEqual([])
    await footer.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(settings.locator('[data-settings-anchor="model.add-provider"]')).toBeVisible()
    expect(server.requests).toBeGreaterThan(probes)
    expect(await grants()).toEqual([
      expect.objectContaining({
        hostname: host,
        port: server.port,
        protocol: 'http',
        sharedWithAgent: true
      })
    ])
  } finally {
    await server.close()
  }
})

const selectHttpProvider = async (
  page: Page,
  server: ModelServer
): Promise<UpsertProviderRequest> => {
  const edit: UpsertProviderRequest = {
    type: 'custom',
    name: 'HTTP fixture',
    baseUrl: server.baseUrl,
    model: 'mock-model',
    key: 'synthetic-test-only',
    apiEndpoints: ['messages']
  }
  const id = await page.evaluate(async (edit) => {
    const settings = window.api.settings
    const saved = await settings.saveValidatedProvider(edit)
    if (!saved.providerId || !saved.validation.ok)
      throw new Error('HTTP fixture provider failed validation')
    await settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    await settings.setActiveProvider({ id: saved.providerId, model: edit.model })
    await settings.setAgentFramework({ id: 'open-science-agent' })
    return saved.providerId
  }, edit)
  return { ...edit, id }
}

const revokeSharedAccess = async (page: Page): Promise<void> => {
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
}

test('starts a clean draft after the first message in a new session was blocked @pr-mainline-conversation', async ({
  app
}) => {
  const server = await startModelServer(nonLoopbackHost())
  try {
    const page = await app.completeOnboarding()
    await selectHttpProvider(page, server)
    await revokeSharedAccess(page)
    const before = server.requests
    await createProject(page, 'HTTP blocked draft')
    const prompt = 'Start a new conversation after revocation.'
    await submitPromptViaUi(page, prompt)
    await assertNotice(page)
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(page.getByText('What would you like to research?', { exact: true })).toBeVisible()
    await expect(page.getByTestId('composer-notice-slot')).toHaveCount(0)
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .locator('button[data-slot="session-open-button"]')
      .filter({ hasText: prompt.slice(0, 36) })
      .click()
    await assertNotice(page)
    expect(server.requests).toBe(before)
  } finally {
    await server.close()
  }
})

test('restores the blocked conversation across restart and resumes after reauthorization @pr-mainline-conversation', async ({
  app
}) => {
  const server = await startModelServer(nonLoopbackHost())
  try {
    let page = await app.completeOnboarding()
    const edit = await selectHttpProvider(page, server)
    const project = 'HTTP allowlist'
    const prompt = 'Reply briefly without tools.'
    await createProject(page, project)
    await submitPromptViaUi(page, prompt)
    await expect(page.getByText('ALLOWLIST_FIXTURE_OK', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
    await revokeSharedAccess(page)
    const beforeDenial = server.requests
    await submitPromptViaUi(page, 'Reply again after revocation.')
    await assertNotice(page)
    page = await app.restart()
    await openProjectSession(page, project, prompt)
    await assertNotice(page)
    expect(server.requests).toBe(beforeDenial)
    const restored = await page.evaluate(
      (edit) => window.api.settings.saveValidatedProvider(edit),
      edit
    )
    expect(restored.validation.ok).toBe(true)
    await submitPromptViaUi(page, 'Reply after authorization is restored.')
    await expect(page.getByText('ALLOWLIST_FIXTURE_OK', { exact: true })).toBeVisible({
      timeout: 60_000
    })
  } finally {
    await server.close()
  }
})

test('shows the local denial when an existing conversation switches to an untrusted HTTP provider @pr-mainline-conversation', async ({
  app
}) => {
  const host = nonLoopbackHost()
  const local = await startModelServer('127.0.0.1')
  try {
    const remote = await startModelServer(host)
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
      await assertNotice(page)
      expect(remote.requests).toBe(requestsBeforeSwitch)
      await page.getByRole('button', { name: 'New', exact: true }).click()
      await expect(
        page.getByText('What would you like to research?', { exact: true })
      ).toBeVisible()
      await expect(page.getByTestId('composer-notice-slot')).toHaveCount(0)
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .getByRole('button', { name: /Session status: .*Reply before switching models/ })
        .click()
      await assertNotice(page)
      expect(remote.requests).toBe(requestsBeforeSwitch)
    } finally {
      await remote.close()
    }
  } finally {
    await local.close()
  }
})
