import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  test(`built-in harness shows actionable ${protocol} provider errors across restart`, async ({
    app
  }, testInfo) => {
    test.setTimeout(180_000)
    let reject = true
    const paths: string[] = []
    const gateway = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        )
        return
      }
      paths.push(request.url!)
      if (reject) {
        response.writeHead(400, {
          'content-type': 'application/json',
          'x-request-id': 'desktop-provider-request'
        })
        response.end(
          JSON.stringify({ error: { code: 'model_unavailable', message: 'Model is unavailable' } })
        )
        return
      }
      const text = 'PROVIDER_RECOVERED_OK'
      const events =
        protocol === 'chat-completions'
          ? [
              { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
            ]
          : protocol === 'responses'
            ? [
                { type: 'response.output_text.delta', delta: text },
                { type: 'response.completed', response: {} }
              ]
            : [
                { type: 'content_block_delta', delta: { type: 'text_delta', text } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                { type: 'message_stop' }
              ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
      )
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    try {
      let page = await app.completeOnboarding()
      await page.evaluate(
        async ({ baseUrl, protocol }) => {
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          const settings = await window.api.settings.upsertProvider({
            type: 'custom',
            name: 'Provider error acceptance',
            baseUrl,
            model: 'provider-error-fixture',
            key: 'local-fixture',
            apiEndpoints: [protocol],
            contextWindow: 200_000,
            maxOutputTokens: 4096
          })
          const provider = settings.providers.find(
            (item) => item.name === 'Provider error acceptance'
          )!
          await window.api.settings.setActiveProvider({
            id: provider.id,
            model: 'provider-error-fixture'
          })
          await window.api.settings.setAgentFramework({ id: 'open-science-agent' })
        },
        { baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, protocol }
      )
      const name = `Provider errors ${protocol}`
      const projectId = await createProject(page, name)
      const prompt = 'Reply briefly without using tools.'
      await submitPromptViaUi(page, prompt)
      const notice = (): ReturnType<typeof page.getByTestId> =>
        page.getByTestId('conversation-composer-dock').getByTestId('composer-notice-slot')
      await expect(
        notice().getByRole('heading', { name: 'Model configuration needs attention', exact: true })
      ).toBeVisible({ timeout: 60_000 })
      await expect(notice()).toContainText(
        'The selected model is unavailable. Select another model in Settings.'
      )
      await expect(notice()).not.toContainText('An unexpected application error occurred')
      await notice().locator('summary').click()
      await expect(notice().locator('pre')).toContainText('model_not_found')
      await expect(notice().locator('pre')).not.toContainText('Model is unavailable')
      await expect(notice().locator('pre')).toContainText('desktop-provider-request')
      await expect
        .poll(async () => {
          const log = await readFile(
            await app.captureMainLog(`provider-error-${protocol}.log`),
            'utf8'
          )
          return log
            .split('\n')
            .flatMap((line) => {
              try {
                return [JSON.parse(line)]
              } catch {
                return []
              }
            })
            .find((record) => record.msg === 'model request failed')?.data
        })
        .toMatchObject({
          protocol,
          model: 'provider-error-fixture',
          status: 400,
          phase: 'response',
          code: 'model_not_found',
          requestId: 'desktop-provider-request'
        })
      await page.screenshot({ path: testInfo.outputPath('provider-error.png'), fullPage: true })
      await notice().getByRole('button', { name: 'Model settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(settings).toBeVisible()
      await expect(
        settings.getByText('Provider error acceptance', { exact: true }).first()
      ).toBeVisible()
      await settings.getByRole('button', { name: 'Close settings' }).click()
      const outcome = async (): Promise<unknown> =>
        page.evaluate(
          async (projectId) =>
            (await window.api.sessions.loadAll()).sessions
              .find((session) => session.projectId === projectId)
              ?.messages.find((message) => message.role === 'user')?.turnOutcome,
          projectId
        )
      const expected = {
        kind: 'failed',
        failure: {
          reason: 'configuration/model-unavailable',
          diagnostics: {
            protocol,
            model: 'provider-error-fixture',
            status: 400,
            requestId: 'desktop-provider-request',
            phase: 'response',
            code: 'model_not_found'
          }
        }
      }
      await expect.poll(outcome).toMatchObject(expected)
      page = await app.restart()
      await openProjectSession(page, name, prompt)
      await expect(
        notice().getByRole('heading', { name: 'Model configuration needs attention', exact: true })
      ).toBeVisible()
      await expect.poll(outcome).toMatchObject(expected)
      reject = false
      await notice().getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(page.getByText('PROVIDER_RECOVERED_OK', { exact: true })).toBeVisible({
        timeout: 60_000
      })
      await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
      await expect(notice()).toHaveCount(0)
      expect(paths.length).toBeGreaterThanOrEqual(2)
      const suffix = protocol === 'chat-completions' ? '/chat/completions' : `/${protocol}`
      expect(paths.every((path) => path.endsWith(suffix))).toBe(true)
      await testInfo.attach('provider-error-evidence', {
        body: JSON.stringify({ protocol, paths, expected }),
        contentType: 'application/json'
      })
    } finally {
      gateway.closeAllConnections()
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
    }
  })
}
