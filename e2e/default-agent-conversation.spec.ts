import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { submitPromptViaUi } from './fixtures/conversation'
import { openSettingsPage } from './fixtures/settings-preferences'
import { createProject } from './certification/helpers'

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  test(
    `default Agent completes two turns over ${protocol}`,
    { tag: '@default-agent-release' },
    async ({ app }) => {
      const requests: string[] = []
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
        const previous = JSON.stringify(body)
        const text = previous.includes('SECOND_TURN') ? 'SECOND_REPLY_OK' : 'FIRST_REPLY_OK'
        requests.push(previous)
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
        const page = await app.completeOnboarding()
        // Do not select a framework: certify the fresh profile's actual product default.
        const settings = await openSettingsPage(page, 'Agent')
        await expect(
          settings.getByRole('radio', { name: 'Use Open-Science Agent', exact: true })
        ).toHaveAttribute('aria-checked', 'true')
        await settings.getByRole('button', { name: 'Close settings' }).click()
        await page.evaluate(
          async ({ baseUrl, protocol }) => {
            await window.api.settings.setSessionDetailsModel({
              configuration: { mode: 'disabled' }
            })
            const settings = await window.api.settings.upsertProvider({
              type: 'custom',
              name: 'Default Agent certification',
              baseUrl,
              model: 'default-agent-fixture',
              key: 'local-fixture',
              apiEndpoints: [protocol],
              contextWindow: 200_000,
              maxOutputTokens: 4096
            })
            const provider = settings.providers.find(
              (item) => item.name === 'Default Agent certification'
            )!
            await window.api.settings.setActiveProvider({ id: provider.id, model: provider.model! })
          },
          { baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, protocol }
        )
        const projectId = await createProject(page, `Default Agent ${protocol}`)
        await submitPromptViaUi(page, 'FIRST_TURN: reply briefly without tools.')
        await expect(page.getByText('FIRST_REPLY_OK', { exact: true })).toBeVisible({
          timeout: 60_000
        })
        await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
        await submitPromptViaUi(page, 'SECOND_TURN: reply briefly without tools.')
        await expect(page.getByText('SECOND_REPLY_OK', { exact: true })).toBeVisible({
          timeout: 60_000
        })
        await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
        const sessions = await page.evaluate(
          async () => (await window.api.sessions.loadAll()).sessions
        )
        expect(sessions.filter((session) => session.projectId === projectId)).toMatchObject([
          { agentFrameworkId: 'open-science-agent' }
        ])
        expect(requests).toHaveLength(2)
        expect(requests[1]).toContain('FIRST_REPLY_OK')
        await expect(page.locator('[data-slot="turn-outcome-notice"]')).toHaveCount(0)
      } finally {
        gateway.closeAllConnections()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
      }
    }
  )
}
