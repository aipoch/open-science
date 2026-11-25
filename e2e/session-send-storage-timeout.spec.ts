import { expect } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Locator, Page } from 'playwright'
import type { RendererFailureReport } from '../src/shared/diagnostics'
import type { SendAttemptEvent } from '../src/shared/send-attempt-diagnostics'
import { createProject } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'hidden' })

const projectA = 'Storage timeout project A'
const projectB = 'Storage timeout project B'
const seedA = 'Previous prompt in A'
const seedB = 'Previous prompt in B'
const promptA = 'Retry the slow save in A'
const promptB = 'Send independently in B'
const attachment = 'timeout-notes.txt'
const markers = [seedA, seedB, promptA, promptB]
const editor = (page: Page): Locator => page.getByRole('textbox', { name: 'Ask anything' })
const thinking = (page: Page): Locator => page.getByTestId('open-science-thinking-indicator')
const transcript = (page: Page): Locator =>
  page.getByRole('region', { name: 'Conversation', exact: true })
const reply = (page: Page, marker: string): Locator =>
  transcript(page).getByText(`Reply for ${marker}`, { exact: true })

async function openProjectSession(page: Page, name: string, id: string): Promise<void> {
  await page.getByRole('button', { name: 'All projects', exact: true }).click()
  await page
    .getByRole('region', { name: 'Projects', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}(?:$|[, ])`) })
    .click()
  const row = page.locator(`[data-session-id="${id}"] [data-slot="session-open-button"]`)
  if ((await row.getAttribute('aria-current')) !== 'page') await row.click()
}

type StorageProbe = {
  held: boolean
  released: boolean
  appendIds: string[]
  messageId?: string
  cleanups: number
  timeout?: RendererFailureReport['sessionWrite']
  sendTrace: SendAttemptEvent[]
}

for (const phase of ['earlier-save', 'prepare-prompt', 'append-user'] as const) {
  test(`recovers a slow ${phase} acknowledgement across projects without submitting twice`, async ({
    app
  }) => {
    const requests: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      if (!JSON.parse(body).stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
        )
        return
      }
      const marker = markers.reduce(
        (last, value) => (body.lastIndexOf(value) > body.lastIndexOf(last) ? value : last),
        markers[0]
      )
      requests.push(marker)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `Reply for ${marker}` }, finish_reason: null }] })}\n\n`
      )
      response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve, reject) =>
      server.once('error', reject).listen(0, '127.0.0.1', resolve)
    )
    let releaseWrite: (() => Promise<void>) | undefined
    try {
      const page = await app.completeOnboarding()
      await app.setMainWindowSize(1280, 900)
      await page.evaluate(
        async (baseUrl) => {
          await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
          const name = 'Local storage timeout provider'
          const state = await window.api.settings.upsertProvider({
            type: 'custom',
            name,
            baseUrl,
            model: 'repro-model',
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
      await createProject(page, projectA)
      await submitPromptViaUi(page, seedA)
      await expect(reply(page, seedA)).toBeVisible()
      await expect(thinking(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'All projects', exact: true }).click()
      await createProject(page, projectB)
      await submitPromptViaUi(page, seedB)
      await expect(reply(page, seedB)).toBeVisible()
      await expect(thinking(page)).toHaveCount(0)
      const [a, b] = await page.evaluate(
        async (prompts) => {
          const { sessions } = await window.api.sessions.loadAll()
          return prompts.map(
            (prompt) =>
              sessions.find((session) =>
                session.messages.some((item) => item.role === 'user' && item.content === prompt)
              )!.id
          )
        },
        [seedA, seedB]
      )

      const electron = (app as unknown as { application: ElectronApplication }).application
      await electron.evaluate(
        ({ ipcMain }, { sessionId, phase }) => {
          const handlers = (
            ipcMain as unknown as {
              _invokeHandlers: Map<
                string,
                (event: unknown, request: { id?: string }, options?: SaveOptions) => unknown
              >
            }
          )._invokeHandlers
          type SaveOptions = {
            conflictRebaseFields?: string[]
            conversationCommands?: Array<{
              kind: string
              promptMessageId?: string
              message?: { id: string }
            }>
          }
          const channel = 'sessions:save-session'
          const original = handlers.get(channel)!
          const gate = Promise.withResolvers<void>()
          const state: StorageProbe = {
            held: false,
            released: false,
            appendIds: [],
            cleanups: 0,
            sendTrace: []
          }
          Object.assign(globalThis, { sendStorageFixture: { state, release: gate.resolve } })
          ipcMain.on('diagnostics:renderer-failure', (_, report: RendererFailureReport) => {
            const storage = report.sessionWrite
            if (storage?.sessionId === sessionId && storage.recovery?.event === 'send-timeout')
              state.timeout = storage
            const send = report.sendAttempt
            if (send?.sessionId === sessionId) state.sendTrace.push(send)
          })
          const delayAcknowledgement = async (): Promise<void> => {
            state.held = true
            await gate.promise
            state.released = true
          }
          const pin = handlers.get('sessions:set-pinned')!
          handlers.set('sessions:set-pinned', async (...args) => {
            const result = await pin(...args)
            if (
              phase === 'earlier-save' &&
              Reflect.get(args[1], 'sessionId') === sessionId &&
              !state.held
            )
              await delayAcknowledgement()
            return result
          })
          handlers.set(channel, async (event, request, options) => {
            const commands = request.id === sessionId ? (options?.conversationCommands ?? []) : []
            for (const command of commands) {
              if (command.kind === 'prepare-prompt') state.messageId ??= command.promptMessageId
              if (command.kind === 'append-user' && command.message)
                state.appendIds.push(command.message.id)
            }
            const result = await original(event, request, options)
            if (commands.some((command) => command.kind === 'rollback-prompt')) state.cleanups += 1
            // 延迟真实数据库写入的回执，让旧消息可能已落盘，但发送方仍看不到结果。
            if (
              !state.held &&
              request.id === sessionId &&
              (commands.some((command) => command.kind === phase) ||
                (phase === 'earlier-save' && options?.conflictRebaseFields?.includes('pinned')))
            )
              await delayAcknowledgement()
            return result
          })
        },
        { sessionId: a, phase }
      )
      releaseWrite = () =>
        electron.evaluate(() => {
          const target = globalThis as unknown as { sendStorageFixture: { release: () => void } }
          target.sendStorageFixture.release()
        })
      const probe = (): Promise<StorageProbe> =>
        electron.evaluate(
          () =>
            (
              globalThis as unknown as {
                sendStorageFixture: { state: StorageProbe }
              }
            ).sendStorageFixture.state
        )
      const persisted = (): Promise<
        Array<{ id: string; outcome: string | undefined; attachments: string[] | undefined }>
      > =>
        page.evaluate(
          async ({ id, content }) => {
            const session = (await window.api.sessions.loadAll()).sessions.find(
              (item) => item.id === id
            )!
            return session.messages
              .filter((item) => item.role === 'user' && item.content.includes(content))
              .map(({ id, turnOutcome, uploads }) => ({
                id,
                outcome: turnOutcome?.kind,
                attachments: uploads?.map(({ name }) => name)
              }))
          },
          { id: a, content: promptA }
        )

      await openProjectSession(page, projectA, a)
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name: attachment,
        mimeType: 'text/plain',
        buffer: Buffer.from('Retain this attachment on retry.')
      })
      await expect(page.getByText(attachment, { exact: true })).toBeVisible()
      if (phase === 'earlier-save') {
        await page.getByRole('button', { name: `Open actions for ${seedA}`, exact: true }).click()
        await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
        await expect.poll(async () => (await probe()).held).toBe(true)
      }
      await submitPromptViaUi(page, promptA)
      await expect.poll(async () => (await probe()).held).toBe(true)
      expect(await persisted()).toHaveLength(phase === 'append-user' ? 1 : 0)

      await openProjectSession(page, projectB, b)
      await submitPromptViaUi(page, promptB)
      await expect(reply(page, promptB)).toBeVisible()
      expect((await probe()).released).toBe(false)
      expect(requests.filter((marker) => marker === promptA)).toHaveLength(0)

      if (phase === 'append-user') {
        // A 超时发生在用户仍停留在 B 的时候。
        await expect.poll(async () => (await probe()).timeout?.recovery?.event).toBe('send-timeout')
        await expect(reply(page, promptB)).toBeVisible()
      }

      await openProjectSession(page, projectA, a)
      await expect(
        page.getByText(
          phase === 'earlier-save'
            ? 'Waiting for earlier conversation changes timed out. Try sending again.'
            : 'Saving the message before sending timed out. Try sending again.',
          { exact: false }
        )
      ).toBeVisible()
      await expect(thinking(page)).toHaveCount(0)
      await expect(editor(page)).toContainText(promptA)
      await expect(page.getByText(attachment, { exact: true })).toBeVisible()
      const retry = page.getByRole('button', { name: 'Retry', exact: true })
      await expect(retry).toBeDisabled()
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect(editor(page)).toContainText(promptA)
      expect(requests.filter((marker) => marker === promptA)).toHaveLength(0)

      await releaseWrite()
      await expect
        .poll(async () => await probe())
        .toMatchObject({
          released: true,
          cleanups: phase === 'earlier-save' ? 0 : 1
        })
      await expect(retry).toBeEnabled()
      await retry.click()
      await expect(reply(page, promptA)).toBeVisible()
      const { messageId, appendIds, timeout, sendTrace } = await probe()
      expect([...new Set(appendIds)]).toEqual([messageId])
      const operation =
        phase === 'earlier-save'
          ? 'flush-before-send'
          : phase === 'append-user'
            ? 'flush-before-dispatch'
            : phase
      expect(timeout).toMatchObject({
        sessionId: a,
        projectId: expect.any(String),
        recovery: {
          promptMessageId: messageId,
          elapsedMs: expect.any(Number),
          operation
        }
      })
      const expired = sendTrace.find(
        (event) => event.phase === operation && event.result === 'timed-out'
      )
      expect(expired).toMatchObject({ promptMessageId: messageId, timeoutMs: 15_000 })
      expect(sendTrace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sendAttemptId: expired!.sendAttemptId,
            phase: operation,
            result: 'late-result'
          }),
          expect.objectContaining({
            sendAttemptId: expired!.sendAttemptId,
            phase: 'composer-feedback',
            detail: 'error-reported'
          })
        ])
      )
      const retryStart = sendTrace.find(
        (event) =>
          event.phase === 'send' &&
          event.result === 'started' &&
          event.sendAttemptId !== expired!.sendAttemptId
      )
      expect(retryStart).toMatchObject({ promptMessageId: messageId })
      await expect
        .poll(persisted)
        .toEqual([{ id: messageId, outcome: 'completed', attachments: [attachment] }])
      expect(requests.filter((marker) => marker === promptA)).toHaveLength(1)
    } finally {
      await releaseWrite?.().catch(() => undefined)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
