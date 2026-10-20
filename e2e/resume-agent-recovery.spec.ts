import { expect, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { x as extract } from 'tar'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import type { PersistedChatSession } from '../src/shared/session-persistence'

const PROMPT = 'Run the framework Resume acceptance journey.'
const COMPLETED = 'Framework Resume completed.'
let selector: Server
let providerBaseUrl: string

test.beforeAll(async () => {
  // CodeBuddy routes Skills with a separate provider call. Replace that external provider too.
  selector = createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '{"skill_names":[]}',
              tool_calls: [
                {
                  id: 'fixture-skills',
                  type: 'function',
                  function: { name: 'select_skills', arguments: '{"skill_names":[]}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
  await new Promise<void>((resolve) => selector.listen(0, '127.0.0.1', resolve))
  const address = selector.address()
  if (!address || typeof address === 'string') throw new Error('Provider fixture has no port.')
  providerBaseUrl = `http://127.0.0.1:${address.port}/v1`
})

test.afterAll(async () => {
  selector.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    selector.close((error) => (error ? reject(error) : resolve()))
  )
})

async function persistedSession(page: Page): Promise<PersistedChatSession> {
  return page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
}

async function stopStreaming(page: Page): Promise<void> {
  const ready = page.getByText('Framework execution ready for Stop.', { exact: false })
  const previousCount = await ready.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(ready).toHaveCount(previousCount + 1)
  await expect(ready.last()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
}

test('Stop, switch framework, Resume preserves the turn in both directions', async ({
  app
}, info) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent({ crossFramework: true, providerBaseUrl })
  await createProjectViaUi(page, 'Resume framework acceptance')

  for (const [index, framework] of (['codebuddy', 'opencode'] as const).entries()) {
    await stopStreaming(page)
    await expect(page.getByTestId('session-config-change')).toHaveCount(index)
    const before = await persistedSession(page)
    const originalPrompt = before.messages.filter((message) => message.role === 'user').at(-1)!
    await page.evaluate(async (id) => {
      await window.api.settings.setAgentFramework({ id })
    }, framework)
    await page.getByRole('button', { name: 'Resume session', exact: true }).click()
    await expect(page.getByText(COMPLETED, { exact: false })).toHaveCount(index + 1, {
      timeout: 60_000
    })
    await expect(page.getByText(COMPLETED, { exact: false }).last()).toBeVisible({
      timeout: 60_000
    })
    await expect.poll(async () => (await persistedSession(page)).status).toBe('idle')
    const after = await persistedSession(page)
    expect(after.id).toBe(before.id)
    expect(after.agentFrameworkId).toBe(framework)
    expect(after.conversationGraph?.runtimeSegments.at(-1)?.frameworkId).toBe(framework)
    expect(after.messages.find((message) => message.id === originalPrompt.id)?.agentTarget).toEqual(
      originalPrompt.agentTarget
    )
    expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(index + 1)
    await expect(page.getByTestId('session-config-change')).toHaveCount(index + 1)
    await page.screenshot({ path: info.outputPath(`resume-${framework}.png`), fullPage: true })
    await writeFile(info.outputPath(`resume-${framework}.json`), JSON.stringify(after, null, 2))
  }
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Summarize the deterministic fixture.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('session-config-change')).toHaveCount(2)
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: PROMPT })
    .click()
  await expect(page.getByTestId('session-config-change')).toHaveCount(2)
  await page.screenshot({ path: info.outputPath('resume-after-restart.png'), fullPage: true })
})

test('failed provider attachment exposes original details and exports real diagnostics', async ({
  app
}, info) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent({ crossFramework: true, providerBaseUrl })
  await createProjectViaUi(page, 'Resume failure acceptance')
  await stopStreaming(page)
  const before = await persistedSession(page)
  const failure = [
    'Resume acceptance attachment failed; api_key=fixture-secret-must-be-redacted',
    `Provider diagnostic: ${'long-provider-detail-'.repeat(35)}`,
    ...Array.from({ length: 16 }, (_, index) => `Diagnostic context line ${index + 1}`)
  ].join('\n')
  await writeFile(join(before.cwd, '.e2e-resume-attachment-failure'), failure)
  await page.evaluate(async () => {
    await window.api.settings.setAgentFramework({ id: 'codebuddy' })
  })
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  const error = page.getByTestId('resume-operation-error')
  await expect(error.getByText('Could not resume this conversation', { exact: true })).toBeVisible()
  await expect(error).toHaveClass(/bg-card/)
  await expect(error).toHaveClass(/border-border/)
  await expect(error).not.toHaveAttribute('data-notice-inline')
  await expect(error.locator('details')).not.toHaveAttribute('open')
  await page.screenshot({ path: info.outputPath('resume-friendly-error.png'), fullPage: true })
  await error.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(error.locator('pre')).toContainText('Resume acceptance attachment failed')
  const titleBounds = await error
    .getByText('Could not resume this conversation', { exact: true })
    .boundingBox()
  const detailsBounds = await error.locator('details').boundingBox()
  expect(titleBounds).not.toBeNull()
  expect(detailsBounds).not.toBeNull()
  expect(Math.abs(titleBounds!.x - detailsBounds!.x)).toBeLessThanOrEqual(1)
  await error.getByRole('button', { name: 'Copy', exact: true }).click()
  const application = (app as unknown as { application: ElectronApplication }).application
  const displayedDetails = (await error.locator('pre').textContent())!.replace(/\r\n/g, '\n')
  await expect
    .poll(async () =>
      (await application.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')
    )
    .toBe(displayedDetails)
  await page.screenshot({ path: info.outputPath('resume-original-details.png'), fullPage: true })
  await page.setViewportSize({ width: 640, height: 850 })
  await page.screenshot({
    path: info.outputPath('resume-light-narrow-expanded.png'),
    fullPage: true
  })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const layout = await error.evaluate((element) => {
    const pre = element.querySelector('pre')!
    return {
      cardWidth: element.getBoundingClientRect().width,
      preWidth: pre.getBoundingClientRect().width,
      preHeight: pre.getBoundingClientRect().height,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    }
  })
  expect(layout.preWidth).toBeLessThan(layout.cardWidth)
  expect(layout.preHeight).toBeLessThanOrEqual(160)
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth)
  await page.screenshot({ path: info.outputPath('resume-dark-narrow.png'), fullPage: true })
  await error.locator('summary').click()
  await page.screenshot({
    path: info.outputPath('resume-dark-narrow-collapsed.png'),
    fullPage: true
  })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await page.screenshot({
    path: info.outputPath('resume-light-narrow-collapsed.png'),
    fullPage: true
  })
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await expect(error).toHaveCount(0)
  const dismissed = await persistedSession(page)
  expect(dismissed.resumeRecovery).toEqual(before.resumeRecovery)
  expect(dismissed.messages).toEqual(before.messages)
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect(error).toBeVisible()
  await expect(error.locator('details')).not.toHaveAttribute('open')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  const archive = info.outputPath('resume-failure-diagnostics.tar.gz')
  await application.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, archive)
  await error.getByRole('button', { name: 'Export diagnostics…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
  await expect(dialog.getByRole('checkbox', { name: 'Current log', exact: true })).toBeChecked()
  await page.screenshot({ path: info.outputPath('resume-diagnostics-dialog.png'), fullPage: true })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog.getByText(/^Diagnostic package exported successfully/)).toBeVisible({
    timeout: 60_000
  })
  await dialog.getByText(/^Diagnostic package exported successfully/).scrollIntoViewIfNeeded()
  await page.screenshot({
    path: info.outputPath('resume-diagnostics-exported.png'),
    fullPage: true
  })
  const unpacked = info.outputPath('unpacked')
  await mkdir(unpacked, { recursive: true })
  await extract({ file: archive, cwd: unpacked })
  const log = await readFile(join(unpacked, 'logs/main.log'), 'utf8')
  expect(log).toContain('acp:resume-session failed')
  expect(log).toContain('Resume acceptance attachment failed')
  expect(log).not.toContain('fixture-secret-must-be-redacted')
  const failureRecord = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => record.event === 'acp:resume-session failed')
  expect(failureRecord.diagnostics).toMatchObject({
    sessionId: before.id,
    frameworkId: 'codebuddy',
    previousFrameworkId: 'opencode'
  })
  const after = await persistedSession(page)
  expect(after.resumeRecovery).toEqual(before.resumeRecovery)
  expect(after.messages).toEqual(before.messages)
  await writeFile(
    info.outputPath('export-verification.json'),
    JSON.stringify(
      {
        sessionId: before.id,
        archive,
        failureRecord,
        errorFound: true,
        secretRedacted: true,
        recoveryUnchanged: true,
        dismissalPreservedRecovery: true,
        retryReopenedSameFailure: true,
        layout
      },
      null,
      2
    )
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await unlink(join(before.cwd, '.e2e-resume-attachment-failure'))
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect(page.getByText(COMPLETED, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(error).toHaveCount(0)
})
