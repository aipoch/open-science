import { expect } from '@playwright/test'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { extract } from 'tar'
import type { SendAttemptEvent } from '../src/shared/send-attempt-diagnostics'
import { submitPromptViaUi } from './fixtures/conversation'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { openGeneralSettings } from './fixtures/settings-preferences'

test.use({ windowMode: 'hidden' })

test('exports correlated send phases for a new, resumed, and live OpenCode conversation', async ({
  app
}, info) => {
  const project = 'Send diagnostics project'
  const marker = 'private-fixture-content-42'
  const filename = 'private-fixture-attachment-42.txt'
  const transcriptReply = 'Deterministic reply: Summarize the deterministic fixture.'
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProjectViaUi(page, project)
  await submitPromptViaUi(page, marker)
  await expect(page.getByText(transcriptReply, { exact: true })).toBeVisible()
  await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
  const sessionId = await page.evaluate(async (prompt) => {
    const { sessions } = await window.api.sessions.loadAll()
    return sessions.find((session) => session.messages.some(({ content }) => content === prompt))!
      .id
  }, marker)

  page = await app.restart()
  const projects = page.getByRole('region', { name: 'Projects', exact: true })
  await projects.getByRole('button', { name: project, exact: true }).click()
  const conversation = page.locator(
    `[data-session-id="${sessionId}"] [data-slot="session-open-button"]`
  )
  if ((await conversation.getAttribute('aria-current')) !== 'page') await conversation.click()
  await expect(
    page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByText(marker, { exact: true })
  ).toBeVisible()
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('private fixture file contents')
  })
  await expect(
    page.getByRole('button', { name: `Remove attachment ${filename}`, exact: true })
  ).toBeVisible()
  await submitPromptViaUi(page, marker + '-resume')
  await expect(page.getByText(transcriptReply, { exact: true })).toHaveCount(2)
  await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)
  await submitPromptViaUi(page, marker + '-live')
  await expect(page.getByText(transcriptReply, { exact: true })).toHaveCount(3)
  await expect(page.getByTestId('open-science-thinking-indicator')).toHaveCount(0)

  const output = info.outputPath('application-send-diagnostics.tar.gz')
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
  const files = await readdir(join(extracted, 'logs'), { recursive: true })
  const events: SendAttemptEvent[] = []
  for (const name of files.filter((file) => /main[^/]*\.log$/.test(file))) {
    const data = await readFile(join(extracted, 'logs', name), 'utf8')
    for (const line of data.split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      if (row.event !== 'conversation send phase') continue
      expect(line).not.toContain(marker)
      expect(line).not.toContain(filename)
      expect(line).not.toContain('e2e-key')
      if (row.diagnostics) events.push(row.diagnostics)
    }
  }
  const sends = events.filter(({ phase, result }) => phase === 'send' && result === 'started')
  expect(sends).toHaveLength(3)
  expect(new Set(sends.map(({ sendAttemptId }) => sendAttemptId)).size).toBe(3)
  for (const send of sends) {
    const attempt = events.filter(({ sendAttemptId }) => sendAttemptId === send.sendAttemptId)
    expect(new Set(attempt.map(({ promptMessageId }) => promptMessageId))).toEqual(
      new Set([send.promptMessageId])
    )
    for (const phase of [
      'prepare-prompt',
      'commit-session',
      'dispatch-prompt',
      'prompt-admission',
      'first-output',
      'turn-terminal'
    ])
      expect(attempt).toEqual(
        expect.arrayContaining([expect.objectContaining({ phase, result: 'completed' })])
      )
  }
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: 'send', mode: 'new-session' }),
      expect.objectContaining({ phase: 'bind-session', sessionId, detail: 'resume-required' }),
      expect.objectContaining({ phase: 'bind-session', sessionId, detail: 'reuse-live' }),
      expect.objectContaining({ phase: 'acp-initialize', result: 'completed' }),
      expect.objectContaining({ phase: 'acp-session-new', result: 'completed' }),
      expect.objectContaining({ phase: 'acp-resume', result: 'completed' })
    ])
  )
})
