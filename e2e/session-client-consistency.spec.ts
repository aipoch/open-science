import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession, sendPrompt } from './certification/helpers'

const row = (page: Page, title: string): Locator =>
  page
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .filter({ hasText: title })

const beginRename = async (page: Page, title: string, draft: string): Promise<Locator> => {
  await row(page, title).hover()
  await page.getByRole('button', { name: 'Rename session title', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Session title', exact: true })
  await input.fill(draft)
  return input
}

test('does not restore a deleted Session from a delayed Web rename receipt', async ({
  app,
  browser
}, testInfo) => {
  test.setTimeout(180_000)
  const first = await app.completeOnboarding()
  await first.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const cwd = await app.createTestDirectory('session-client-consistency')
  const saved = await first.evaluate(async (cwd) => {
    const project = await window.api.projects.create({
      name: 'Session consistency',
      description: ''
    })
    const now = Date.now()
    return window.api.sessions.saveSession({
      id: 'session-client-consistency',
      projectId: project.id,
      title: 'Original title',
      cwd,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: 'original-prompt',
          role: 'user',
          content: 'Original prompt',
          status: 'complete',
          eventIds: [],
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  }, cwd)
  const second = await app.openAdditionalRenderer()
  const web = await browser.newPage()
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await web.goto(await app.authenticatedWebUrl())
    for (const page of [first, second, web])
      await openProjectSession(page, 'Session consistency', 'Original title')
    let receiptReady!: () => void
    const receipt = new Promise<void>((resolve) => {
      receiptReady = resolve
    })
    await web.route('**/rpc/sessions%3Aedit-details', async (route) => {
      const response = await route.fetch()
      receiptReady()
      await released
      await route.fulfill({ response })
    })
    const input = await beginRename(web, 'Original title', 'Renamed before deletion')
    await input.press('Enter')
    await receipt
    // The server committed the rename, but Web has not received its RPC acknowledgement.
    await expect(row(second, 'Renamed before deletion')).toBeVisible()
    await first.evaluate(async ({ projectId, id }) => {
      await window.api.sessions.deleteSession({ projectId, sessionId: id })
    }, saved)
    await expect(row(web, 'Original title')).toHaveCount(0)
    await expect(row(second, 'Renamed before deletion')).toHaveCount(0)
    const delivered = web.waitForResponse('**/rpc/sessions%3Aedit-details')
    release()
    await (await delivered).finished()
    await web.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect(web.getByRole('textbox', { name: 'Session title', exact: true })).toHaveCount(0)
    expect(
      await first.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        saved
      )
    ).toBeUndefined()
    await web.screenshot({ path: testInfo.outputPath('delayed-receipt-result.png') })
    await expect(row(web, 'Renamed before deletion')).toHaveCount(0)
  } finally {
    release()
    await web.close()
  }
})

test('preserves a Web message edit while another client changes the selected Branch', async ({
  app,
  browser
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const first = await app.configureFakeAgent()
  // This fixture assigns a fixed title; background generation would race that manual edit.
  await first.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const projectName = 'Branch consistency'
  const original = 'Original branch prompt'
  const revised = 'Revised branch prompt'
  const draft = 'Unsaved Web revision'
  const projectId = await createProject(first, projectName)
  await sendPrompt(first, original, 'Deterministic reply: Summarize the deterministic fixture.')
  await expect.poll(() => first.evaluate(() => window.api.storage.detectActive())).toEqual([])
  const conversation = first.getByRole('region', { name: 'Conversation' })
  await conversation.getByText(original, { exact: true }).hover()
  await conversation.getByRole('button', { name: 'Edit message', exact: true }).click()
  await conversation.getByRole('textbox', { name: 'Edit message', exact: true }).fill(revised)
  await conversation.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('2/2')
  await expect(conversation.getByRole('button', { name: 'Branch in new session' })).toBeEnabled()
  // Give this fixture an explicit title before opening other clients; automatic title updates
  // can otherwise race the sidebar lookup while the edited turn is completing.
  await first
    .getByRole('navigation', { name: 'Sessions' })
    .locator('button[data-slot="session-open-button"]')
    .hover()
  await first.getByRole('button', { name: 'Rename session title', exact: true }).click()
  const initialTitle = first.getByRole('textbox', { name: 'Session title', exact: true })
  await initialTitle.fill('Shared revision history')
  await initialTitle.press('Enter')
  await expect(row(first, 'Shared revision history')).toBeVisible()
  const saved = await first.evaluate(async (projectId) => {
    const { sessions } = await window.api.sessions.loadAll()
    return sessions.find((session) => session.projectId === projectId)!
  }, projectId)
  const second = await app.openAdditionalRenderer()
  const web = await browser.newPage()
  try {
    await web.goto(await app.authenticatedWebUrl())
    for (const page of [second, web]) await openProjectSession(page, projectName, saved.title)
    const webConversation = web.getByRole('region', { name: 'Conversation' })
    await web.getByRole('textbox', { name: 'Ask anything' }).fill('Separate composer draft')
    await webConversation.getByText(revised, { exact: true }).hover()
    await webConversation.getByRole('button', { name: 'Edit message', exact: true }).click()
    const editor = webConversation.getByRole('textbox', { name: 'Edit message', exact: true })
    await editor.fill(draft)
    await conversation.getByRole('button', { name: 'Previous message revision' }).click()
    await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
    await expect
      .poll(async () =>
        first.evaluate(
          async ({ projectId, id }) =>
            (await window.api.sessions.loadOne({ projectId, sessionId: id }))?.messages[0]?.content,
          saved
        )
      )
      .toBe(original)
    // A later title event proves the Web subscriber drained the preceding branch update.
    const title = 'Remote branch selected'
    const rename = await beginRename(first, saved.title, title)
    await rename.press('Enter')
    await expect(row(web, title)).toBeVisible()
    await expect(row(second, title)).toBeVisible()
    await expect(editor).toHaveText(draft)
    await expect(web.getByRole('textbox', { name: 'Ask anything' })).toHaveText(
      'Separate composer draft'
    )
    await expect(
      second
        .getByRole('region', { name: 'Conversation' })
        .getByLabel('Message revision', { exact: true })
    ).toHaveText('2/2')
    await web.screenshot({ path: testInfo.outputPath('draft-after-remote-branch.png') })
    await webConversation.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(webConversation.getByText(draft, { exact: true })).toBeVisible()
    await expect(webConversation.getByLabel('Message revision', { exact: true })).toHaveText('3/3')
    await expect(
      webConversation.getByText('Deterministic reply: Summarize the deterministic fixture.', {
        exact: true
      })
    ).toBeVisible()
    await expect.poll(() => first.evaluate(() => window.api.storage.detectActive())).toEqual([])
    await expect(
      webConversation.getByRole('button', { name: 'Branch in new session' })
    ).toBeEnabled()
    await expect
      .poll(async () =>
        first.evaluate(async ({ projectId, id }) => {
          const session = await window.api.sessions.loadOne({ projectId, sessionId: id })
          return {
            prompts: session?.conversationGraph?.messages
              .filter((message) => message.role === 'user')
              .map((message) => message.content)
              .sort()
          }
        }, saved)
      )
      .toEqual({ prompts: [original, revised, draft].sort() })
    await web.reload()
    await expect(web.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(webConversation.getByText(draft, { exact: true })).toBeVisible()
    await expect(webConversation.getByLabel('Message revision', { exact: true })).toHaveText('3/3')
    await expect(web.getByRole('alertdialog')).toHaveCount(0)
    await web.screenshot({
      path: testInfo.outputPath('restored-latest-branch.png'),
      animations: 'disabled'
    })
  } finally {
    await web.close()
  }
})
