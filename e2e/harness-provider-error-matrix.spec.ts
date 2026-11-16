import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import { submitPromptViaUi } from './fixtures/conversation'
import {
  providerErrorCases,
  partialProviderReply,
  type ProviderErrorCase
} from './fixtures/provider-error-cases'

for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  test(`provider error acceptance matrix ${protocol}`, async ({ app }, testInfo) => {
    test.setTimeout(360_000)
    const directory =
      process.env.OPEN_SCIENCE_PROVIDER_ERROR_EVIDENCE ?? testInfo.outputPath('matrix')
    await mkdir(directory, { recursive: true })
    const selected = process.env.OPEN_SCIENCE_PROVIDER_ERROR_CASES?.split(',')
    const cases = providerErrorCases.filter((item) => !selected || selected.includes(item.id))
    let current: ProviderErrorCase = cases[0]
    const requests: { id: string; path: string }[] = []
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
      requests.push({ id: current.id, path: request.url! })
      const item = current
      if (item.wire === 'disconnect') {
        response.destroy()
        return
      }
      const sse = ['invalid-json', 'missing-finish', 'sse-error', 'interrupt'].includes(
        item.wire ?? ''
      )
      response.writeHead(item.status ?? 200, {
        'content-type': sse
          ? 'text/event-stream'
          : item.wire === 'html'
            ? 'text/html'
            : item.wire === 'plain'
              ? 'text/plain'
              : 'application/json',
        'x-request-id': `matrix-${protocol}-${item.id}`,
        ...(item.wire === 'spoofed-connection'
          ? { 'x-open-science-provider-failure': 'connection' }
          : {})
      })
      if (item.wire === 'body-timeout') {
        response.write('{"error":')
        return
      }
      if (item.wire === 'interrupt') {
        response.write(partialProviderReply(protocol))
        // 先让真实网络链路收到正文，再关闭连接，区别于建立连接失败。
        setTimeout(() => response.destroy(), 100)
        return
      }
      let wire = JSON.stringify({
        error: {
          ...(item.code ? { code: item.code } : {}),
          message: item.message ?? 'Request rejected'
        }
      })
      if (item.wire === 'html')
        wire = '<!doctype html><html><body>PRIVATE_GATEWAY_PAGE</body></html>'
      if (item.wire === 'empty') wire = ''
      if (item.wire === 'plain') wire = item.message!
      if (item.wire === 'invalid-json') wire = 'data: {broken-json\n\n'
      if (item.wire === 'missing-finish') wire = partialProviderReply(protocol)
      if (item.wire === 'sse-error')
        wire = `data: ${JSON.stringify({ type: 'error', error: { code: item.code, message: item.message } })}\n\n`
      if (item.wire === 'body-limit' || item.wire === 'body-overflow') {
        const object = { error: { message: item.message ?? 'Oversized response' }, padding: '' }
        const target = item.wire === 'body-limit' ? 16_384 : 20_000
        object.padding = 'x'.repeat(target - Buffer.byteLength(JSON.stringify(object)))
        wire = JSON.stringify(object)
      }
      response.end(wire)
    })
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
    const results: unknown[] = []
    try {
      const page = await app.completeOnboarding()
      await app.setMainWindowSize(1280, 960)
      await page.evaluate(async () => {
        await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
        await window.api.settings.setAgentFramework({ id: 'open-science-agent' })
      })
      const projectId = await createProject(page, `Error acceptance ${protocol}`)
      for (const [index, item] of cases.entries()) {
        await test.step(`${item.id} ${item.name}`, async () => {
          const errorsBefore = testInfo.errors.length
          current = item
          if (index)
            await page
              .getByRole('navigation', { name: 'Sessions', exact: true })
              .getByRole('button', { name: 'New', exact: true })
              .click()
          const model = `error-${item.id.toLowerCase()}`
          await page.evaluate(
            async ({ baseUrl, protocol, model, id }) => {
              const settings = await window.api.settings.upsertProvider({
                type: 'custom',
                name: `Error matrix ${id}`,
                baseUrl,
                model,
                key: 'local-fixture',
                apiEndpoints: [protocol],
                contextWindow: 200_000,
                maxOutputTokens: 4096
              })
              const provider = settings.providers.find(
                (entry) => entry.name === `Error matrix ${id}`
              )!
              await window.api.settings.setActiveProvider({ id: provider.id, model })
            },
            {
              baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`,
              protocol,
              model,
              id: item.id
            }
          )
          const prompt = `${item.id}: Reply briefly without using tools.`
          await submitPromptViaUi(page, prompt)
          const notice = page
            .getByTestId('conversation-composer-dock')
            .getByTestId('composer-notice-slot')
          await expect(notice).toBeVisible({ timeout: 45_000 })
          await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeHidden()
          const outcome = await page.evaluate(
            async ({ projectId, prompt }) =>
              (await window.api.sessions.loadAll()).sessions
                .find(
                  (session) =>
                    session.projectId === projectId &&
                    session.messages.some((message) => message.content === prompt)
                )
                ?.messages.find((message) => message.content === prompt)?.turnOutcome,
            { projectId, prompt }
          )
          const failure = outcome && 'failure' in outcome ? outcome.failure : undefined
          expect
            .soft(outcome?.kind, `${protocol}/${item.id}: 失败落库`)
            .toBe(item.wire === 'interrupt' ? 'interrupted' : 'failed')
          expect.soft(failure?.reason, `${protocol}/${item.id}: 原因分类`).toBe(item.reason)
          expect.soft(failure?.diagnostics.protocol, `${protocol}/${item.id}: 协议`).toBe(protocol)
          expect.soft(failure?.diagnostics.model, `${protocol}/${item.id}: 模型`).toBe(model)
          const phase =
            item.wire === 'invalid-json'
              ? 'event-json'
              : item.wire === 'sse-error'
                ? 'provider'
                : item.wire === 'missing-finish'
                  ? protocol === 'chat-completions'
                    ? 'missing-done'
                    : 'missing-finish'
                  : item.wire === 'interrupt'
                    ? 'stream'
                    : 'response'
          expect.soft(failure?.diagnostics.phase, `${protocol}/${item.id}: 阶段`).toBe(phase)
          if (item.wire !== 'disconnect')
            expect
              .soft(failure?.diagnostics.requestId, `${protocol}/${item.id}: 请求标识`)
              .toBe(`matrix-${protocol}-${item.id}`)
          if (item.status)
            expect
              .soft(failure?.diagnostics.status, `${protocol}/${item.id}: HTTP 状态`)
              .toBe(item.status)
          if (item.code)
            expect
              .soft(failure?.diagnostics.upstreamCode, `${protocol}/${item.id}: 上游码`)
              .toBe(item.code)
          if (item.message)
            expect
              .soft(failure?.diagnostics.safeMessage, `${protocol}/${item.id}: 上游消息`)
              .toBe(item.message.length <= 300 ? item.message : item.message.slice(0, 299) + '…')
          expect
            .soft(JSON.stringify(failure), `${protocol}/${item.id}: HTML 不透传`)
            .not.toContain('PRIVATE_GATEWAY_PAGE')
          // 认证恢复可能另有阻塞提示；截图选中保留上游诊断的当前轮次错误。
          if (item.reason === 'configuration/auth-failed') {
            const more = notice.getByRole('button', { name: /^\d+ more notices?$/ })
            if (await more.isVisible()) {
              await more.click()
              await notice.locator('[data-select-notice*=":turn:"]').click()
            }
          }
          const englishTitle = await notice.getByRole('heading').innerText()
          const actions = await notice
            .locator('button[data-notice-action]')
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getAttribute('data-notice-action'))
            )
          const expectedAction =
            item.wire === 'interrupt'
              ? 'resume'
              : item.reason.startsWith('configuration/')
                ? 'open-provider-settings'
                : item.reason.startsWith('input/')
                  ? 'compact'
                  : 'retry'
          expect.soft(actions, `${protocol}/${item.id}: 恢复操作`).toContain(expectedAction)
          await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
          await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
          await expect(notice.getByRole('heading')).not.toHaveText(englishTitle)
          expect
            .soft(await notice.innerText(), `${protocol}/${item.id}: 不退化为内部错误`)
            .not.toContain('应用发生意外错误')
          const screenshot = `${protocol}-${item.id}.png`
          await page.screenshot({ path: join(directory, screenshot), fullPage: true })
          await notice.locator('summary').click()
          await expect(notice.locator('pre')).toBeVisible()
          await expect(notice.locator('pre')).toContainText(phase)
          if (item.wire === 'interrupt')
            expect
              .soft(await notice.getByRole('button', { name: '关闭错误提示', exact: true }).count())
              .toBe(0)
          await notice.screenshot({ path: join(directory, `${protocol}-${item.id}-details.png`) })
          await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
          await expect(page.locator('html')).toHaveAttribute('lang', 'en')
          const result = {
            protocol,
            ...item,
            model,
            actual: outcome,
            englishTitle,
            actions,
            screenshot,
            passed: testInfo.errors.length === errorsBefore
          }
          results.push(result)
          await writeFile(
            join(directory, `${protocol}-${item.id}.json`),
            JSON.stringify(result, null, 2) + '\n'
          )
        })
      }
      const log = await readFile(
        await app.captureMainLog(`provider-matrix-${protocol}.log`),
        'utf8'
      )
      const records = log
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
        .filter((record) => record.msg === 'model request failed')
      for (const item of cases) {
        expect(
          records.some(
            (record) =>
              record.data?.model === `error-${item.id.toLowerCase()}` &&
              record.data?.protocol === protocol
          ),
          `${protocol}/${item.id}: 真实主进程日志`
        ).toBe(true)
      }
      await writeFile(
        join(directory, `${protocol}-logs.json`),
        JSON.stringify(records, null, 2) + '\n'
      )
      await writeFile(
        join(directory, `${protocol}-requests.json`),
        JSON.stringify(requests, null, 2) + '\n'
      )
      expect(requests.length).toBeGreaterThanOrEqual(cases.length)
      await testInfo.attach('error-matrix-results', {
        body: JSON.stringify(results),
        contentType: 'application/json'
      })
    } finally {
      gateway.closeAllConnections()
      await new Promise<void>((resolve) => gateway.close(() => resolve()))
    }
  })
}
