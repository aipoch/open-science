import { expect } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'

test.use({ windowMode: 'hidden' })

const transcript = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversation', exact: true })
const reply = (page: Page, message: string): Locator =>
  transcript(page).getByText(`Reply to ${message}`, { exact: true })

type SaveCommand = { kind: string; promptMessageId?: string; message?: { id: string } }
type SaveProbe = { startedAt?: number; releasedAt?: number; messageId?: string; saves: string[][] }

for (const phase of ['prepare-prompt', 'append-user']) {
  test(`keeps a single send bubble across projects while waiting for ${phase}`, async ({ app }) => {
    const projectA = 'Send preview project A'
    const projectB = 'Send preview project B'
    const seedA = 'SEND_PREVIEW_SEED_A'
    const seedB = 'SEND_PREVIEW_SEED_B'
    const probeB = 'SEND_PREVIEW_PROBE_B'
    const marker = 'SEND_PREVIEW_WITH_ATTACHMENT'
    const filename = 'send-preview.txt'
    const requests: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      const prompt = [marker, probeB, seedA, seedB].find((candidate) => body.includes(candidate))
      if (!JSON.parse(body).stream || !prompt) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        )
        return
      }
      requests.push(prompt)
      const choices = [{ index: 0, delta: { content: `Reply to ${prompt}` }, finish_reason: null }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices })}\n\n`)
      response.end(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      )
    })
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve)
    )
    let releaseSave: (() => Promise<void>) | undefined
    try {
      const page = await app.completeOnboarding()
      await page.evaluate(
        async (baseUrl) => {
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          const name = 'Send preview fixture'
          const state = await window.api.settings.upsertProvider({
            type: 'custom',
            name,
            baseUrl,
            model: 'fixture-model',
            key: 'local-fixture',
            apiEndpoints: ['chat-completions'],
            contextWindow: 200_000,
            maxOutputTokens: 4096
          })
          const provider = state.providers.find((item) => item.name === name)!
          await window.api.settings.setActiveProvider({ id: provider.id, model: provider.model! })
        },
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      )
      const home = (): Promise<void> =>
        page.getByRole('button', { name: 'All projects', exact: true }).click()
      for (const [project, seed] of [
        [projectA, seedA],
        [projectB, seedB]
      ]) {
        if (project === projectB) await home()
        await createProjectViaUi(page, project)
        await submitPromptViaUi(page, seed)
        await expect(reply(page, seed)).toBeVisible()
        await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
      }
      const { projectId, sessionId } = await page.evaluate(async (text) => {
        const { sessions } = await window.api.sessions.loadAll()
        const session = sessions.find((item) =>
          item.messages.some(({ content }) => content === text)
        )!
        return { projectId: session.projectId, sessionId: session.id }
      }, seedA)
      const open = async (project: string, seed: string): Promise<void> => {
        await home()
        await page
          .getByRole('region', { name: 'Projects', exact: true })
          .getByRole('button', { name: new RegExp(`^${project}(?:$|[, ])`) })
          .click()
        await expect(reply(page, seed)).toBeVisible({ timeout: 4000 })
      }
      await open(projectA, seedA)
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name: filename,
        mimeType: 'text/plain',
        buffer: Buffer.from('A fixture attachment.')
      })
      await expect(
        page.getByRole('button', { name: `Remove attachment ${filename}`, exact: true })
      ).toBeVisible()

      const electron = (app as unknown as { application: ElectronApplication }).application
      await electron.evaluate(
        ({ ipcMain }, { sessionId, phase }) => {
          const handlers = (
            ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
          )._invokeHandlers
          const channel = 'sessions:save-session'
          const save = handlers.get(channel)!
          const gate = Promise.withResolvers<void>()
          const state: SaveProbe = { saves: [] }
          Object.assign(globalThis, { sendPreviewProbe: { state, release: gate.resolve } })
          handlers.set(channel, async (event, request, options) => {
            if ((request as { id?: string })?.id !== sessionId) return save(event, request, options)
            const commands =
              (options as { conversationCommands?: SaveCommand[] })?.conversationCommands ?? []
            state.messageId ??= commands.find(
              ({ kind }) => kind === 'prepare-prompt'
            )?.promptMessageId
            if (commands.length) state.saves.push(commands.map(({ kind }) => kind))
            if (state.startedAt || !commands.some(({ kind }) => kind === phase))
              return save(event, request, options)
            // Hold the acknowledgement after the real write completes, preserving production write ordering.
            const result = await save(event, request, options)
            state.startedAt = Date.now()
            await gate.promise
            state.releasedAt = Date.now()
            return result
          })
        },
        { sessionId, phase }
      )
      const readProbe = (): Promise<SaveProbe> =>
        electron.evaluate(() => {
          const { state } = (globalThis as unknown as { sendPreviewProbe: { state: SaveProbe } })
            .sendPreviewProbe
          return state
        })
      releaseSave = () =>
        electron.evaluate(() => {
          ;(
            globalThis as unknown as { sendPreviewProbe: { release: () => void } }
          ).sendPreviewProbe.release()
        })

      await submitPromptViaUi(page, marker)
      await expect.poll(async () => (await readProbe()).startedAt).toBeDefined()
      const { messageId } = await readProbe()
      expect(messageId).toBeTruthy()
      const bubble = transcript(page).locator(`[data-message-id="${messageId}"]`)
      const sending = bubble.getByRole('status').filter({ hasText: 'Sending…' })
      const copy = bubble.getByRole('button', { name: 'Copy message', exact: true })
      const edit = bubble.getByRole('button', { name: 'Edit message', exact: true })
      await expect(bubble).toContainText(marker, { timeout: 3000 })
      await expect(sending).toBeVisible({ timeout: 3000 })
      await expect(copy).toHaveCount(0)
      await expect(edit).toHaveCount(0)
      await open(projectB, seedB)
      await expect(bubble).toHaveCount(0)
      await submitPromptViaUi(page, probeB)
      await expect(reply(page, probeB)).toBeVisible({ timeout: 4000 })
      await open(projectA, seedA)
      await expect(bubble).toHaveCount(1, { timeout: 3000 })
      await expect(bubble).toContainText(marker, { timeout: 3000 })
      await expect(
        bubble.getByRole('button', { name: `Preview uploaded attachment ${filename}` })
      ).toBeVisible({ timeout: 3000 })
      const ready = await readProbe()
      await expect.poll(() => Date.now() - ready.startedAt!).toBeGreaterThanOrEqual(2500)
      await expect(bubble).toHaveCount(1)
      await expect(sending).toBeVisible({ timeout: 3000 })
      await expect(copy).toHaveCount(0)
      await expect(edit).toHaveCount(0)
      expect((await readProbe()).releasedAt).toBeUndefined()
      expect(requests).not.toContain(marker)
      await bubble.evaluate((node) => node.setAttribute('data-send-preview-test', 'before-ack'))
      await releaseSave()
      const acknowledgement = await readProbe()
      expect(acknowledgement.releasedAt! - acknowledgement.startedAt!).toBeLessThan(15_000)
      await expect(reply(page, marker)).toBeVisible()
      await expect(bubble).toHaveCount(1)
      await expect(bubble).toHaveAttribute('data-send-preview-test', 'before-ack')
      await expect(sending).toHaveCount(0)
      await expect(copy).toHaveCount(1)
      await expect(edit).toHaveCount(1)
      await expect(
        bubble.getByRole('button', { name: `Preview uploaded attachment ${filename}` })
      ).toBeVisible()
      expect(requests.filter((prompt) => prompt === marker)).toHaveLength(1)
      expect((await readProbe()).saves).toEqual([['prepare-prompt'], ['append-user', 'start-run']])
      const persisted = await page.evaluate(
        async ({ projectId, sessionId, marker }) => {
          const session = await window.api.sessions.loadOne({ projectId, sessionId })
          return session?.messages
            .filter(({ content }) => content === marker)
            .map(({ id, uploads }) => ({
              id,
              filenames: uploads?.map(({ name }) => name)
            }))
        },
        { projectId, sessionId, marker }
      )
      expect(persisted).toEqual([{ id: messageId, filenames: [filename] }])
      await bubble.getByRole('button', { name: `Preview uploaded attachment ${filename}` }).click()
      await expect(page.getByText('A fixture attachment.', { exact: true })).toBeVisible()
      console.log(
        `${phase} acknowledgement released after ${acknowledgement.releasedAt! - acknowledgement.startedAt!} ms`
      )
    } finally {
      await releaseSave?.()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
