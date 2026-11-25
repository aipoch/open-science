import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { extract } from 'tar'
import type { SendAttemptEvent } from '../src/shared/send-attempt-diagnostics'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { openGeneralSettings } from './fixtures/settings-preferences'

test.use({ windowMode: 'hidden' })

test('exports checkpoint lock contention and its outcome for each send attempt', async ({
  app
}, info) => {
  test.setTimeout(150_000)
  const project = 'Checkpoint diagnostics project'
  const seed = 'checkpoint-fixture-seed'
  const blocked = 'checkpoint-fixture-timeout'
  const retried = 'checkpoint-fixture-retry'
  const markers = [seed, blocked, retried]
  const providerRequests: string[] = []
  const reply = (marker: string): string => `Reply for ${marker}`
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
    const marker = markers.findLast((candidate) => body.includes(candidate))!
    providerRequests.push(marker)
    const choices = [{ index: 0, delta: { content: reply(marker) }, finish_reason: null }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices })}\n\n`)
    response.end(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    )
  })
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  )
  let releaseLock: (() => Promise<void>) | undefined
  try {
    let page = await app.completeOnboarding()
    await page.evaluate(
      async (baseUrl) => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        const name = 'Checkpoint fixture provider'
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
        const provider = state.providers.find((candidate) => candidate.name === name)!
        await window.api.settings.setActiveProvider({ id: provider.id, model: provider.model! })
      },
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    )
    await createProjectViaUi(page, project)
    await submitPromptViaUi(page, seed)
    await expect(page.getByText(reply(seed), { exact: true })).toBeVisible()
    await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
    const { id, providerSessionId } = await page.evaluate(async (prompt) => {
      const session = (await window.api.sessions.loadAll()).sessions.find(({ messages }) =>
        messages.some(({ content }) => content === prompt)
      )!
      return { id: session.id, providerSessionId: session.providerSessionId }
    }, seed)
    expect(providerSessionId).toBeTruthy()
    const storage = join(dirname(await app.createTestDirectory('checkpoint-anchor')), 'storage')
    const digest = createHash('sha256').update(providerSessionId!).digest('hex')
    const checkpoint = join(storage, 'open-science-agent', 'sessions', 'checkpoints', digest)
    await access(checkpoint + '.jsonl')
    const lock = checkpoint + '.journal.lock'

    page = await app.restart()
    await page
      .getByRole('region', { name: 'Projects', exact: true })
      .getByRole('button', { name: project, exact: true })
      .click()
    const session = page.locator(`[data-session-id="${id}"] [data-slot="session-open-button"]`)
    if ((await session.getAttribute('aria-current')) !== 'page') await session.click()
    await expect(page.getByText(reply(seed), { exact: true })).toBeVisible()

    // 使用隔离资料目录中的实际日志锁文件，保留 ACP 和存储的正常执行路径。
    const holdLock = async (): Promise<void> => {
      await writeFile(lock, '', { flag: 'wx', mode: 0o600 })
      releaseLock = async () => {
        await unlink(lock)
        releaseLock = undefined
      }
    }
    const waitStarts = async (): Promise<number> => {
      const log = await readFile(join(storage, 'logs', 'main.log'), 'utf8')
      return log.split('\n').filter((line) => {
        if (!line.endsWith('}') || !line.includes('"checkpoint-lock"')) return false
        const { data } = JSON.parse(line)
        return (
          data?.sessionId === id && data.phase === 'checkpoint-lock' && data.result === 'started'
        )
      }).length
    }
    await holdLock()
    await submitPromptViaUi(page, blocked)
    await expect.poll(waitStarts).toBe(1)
    await expect(page.getByTestId('open-science-thinking-indicator')).toBeVisible()
    await expect(page.getByTestId('composer-notice-slot')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
    expect(providerRequests).toEqual([seed])
    await releaseLock!()

    await holdLock()
    await submitPromptViaUi(page, retried)
    await expect.poll(waitStarts).toBe(2)
    await releaseLock!()
    await expect(page.getByText(reply(retried), { exact: true })).toBeVisible()
    await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
    expect(providerRequests).toEqual([seed, retried])
    const saved = await page.evaluate(async (sessionId) => {
      const session = (await window.api.sessions.loadAll()).sessions.find(
        ({ id }) => id === sessionId
      )!
      return session.messages.filter(({ role }) => role === 'user').map(({ content }) => content)
    }, id)
    expect(saved).toEqual([seed, retried])

    const output = info.outputPath('application-checkpoint-diagnostics.tar.gz')
    await mkdir(info.outputPath(), { recursive: true })
    const electron = (app as unknown as { application: ElectronApplication }).application
    await electron.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, output)
    const settings = await openGeneralSettings(page)
    await settings.getByRole('button', { name: 'Export diagnostics…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
    await dialog.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(
      dialog.getByText(/Diagnostic package (exported successfully|partially exported)/)
    ).toBeVisible({ timeout: 45_000 })

    const extracted = info.outputPath('unpacked')
    await mkdir(extracted)
    await extract({ file: output, cwd: extracted })
    const rows = await Promise.all(
      ['main.log', 'desktop/main.log'].map(async (file) => {
        const data = await readFile(join(extracted, 'logs', file), 'utf8')
        return data
          .split('\n')
          .filter(Boolean)
          .flatMap((line, index) => {
            const row = JSON.parse(line)
            if (row.event !== 'conversation send phase' || row.diagnostics?.sessionId !== id)
              return []
            return [
              {
                file,
                line: index + 1,
                time: row.t as string,
                event: row.diagnostics as SendAttemptEvent
              }
            ]
          })
      })
    )
    const events = rows.flat()
    const lockEvents = events.filter(({ event }) => event.phase === 'checkpoint-lock')
    expect(lockEvents.map(({ event }) => event.result)).toEqual([
      'started',
      'timed-out',
      'started',
      'completed'
    ])
    const [start, timeout, retryStart, acquired] = lockEvents.map(({ event }) => event)
    for (const [begin, end, resumeResult] of [
      [start, timeout, 'failed'],
      [retryStart, acquired, 'completed']
    ] as const) {
      expect(begin.operationId).toBeTruthy()
      expect(end).toMatchObject({
        sendAttemptId: begin.sendAttemptId,
        promptMessageId: begin.promptMessageId,
        operationId: begin.operationId,
        timeoutMs: 30_000
      })
      const attempt = events.filter(({ event }) => event.sendAttemptId === begin.sendAttemptId)
      expect(attempt.map(({ event }) => event)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'send',
            result: 'started',
            promptMessageId: begin.promptMessageId
          }),
          expect.objectContaining({
            phase: 'acp-resume',
            result: resumeResult,
            promptMessageId: begin.promptMessageId
          })
        ])
      )
    }
    expect(retryStart.sendAttemptId).not.toBe(start.sendAttemptId)
    expect(timeout.durationMs).toBeGreaterThanOrEqual(29_900)
    expect(acquired.durationMs).toBeLessThan(30_000)
    const evidence = JSON.stringify(lockEvents, null, 2)
    for (const privateValue of [lock, seed, blocked, retried])
      expect(evidence).not.toContain(privateValue)
    await writeFile(info.outputPath('checkpoint-lock-evidence.json'), evidence + '\n')
  } finally {
    if (releaseLock) await releaseLock()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
