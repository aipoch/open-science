import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Scroll release project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const LONG_STREAM_PROMPT = 'Stream the long scroll journey.'
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

test('releases follow-output when the reader scrolls up mid-stream', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  for (let turn = 0; turn < 6; turn += 1) {
    await textbox.fill(`Turn ${turn}: ${USER_MESSAGE}`)
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(turn + 1)
  }

  await textbox.fill(LONG_STREAM_PROMPT)
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  const readScrollTop = (): Promise<number> =>
    page.evaluate(
      () => document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTop ?? -1
    )

  // Wait until follow-output is clearly engaged.
  let scrollTop = await readScrollTop()
  for (let attempt = 0; attempt < 40 && scrollTop < 1100; attempt += 1) {
    await page.waitForTimeout(100)
    scrollTop = await readScrollTop()
  }

  // Reader scrolls up inside the transcript viewport.
  const viewportBox = await conversation.boundingBox()
  await page.mouse.move(
    viewportBox!.x + viewportBox!.width / 2,
    viewportBox!.y + viewportBox!.height / 2
  )
  await page.mouse.wheel(0, -600)
  await page.mouse.wheel(0, -600)
  const afterWheel = await readScrollTop()

  // While the reply keeps streaming, the reader's position must hold (no re-follow).
  await page.waitForTimeout(900)
  const later = await readScrollTop()
  expect(later - afterWheel).toBeLessThan(120)
})
