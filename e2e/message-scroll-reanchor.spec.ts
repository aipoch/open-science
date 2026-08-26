import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Scroll anchor project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
// The fake agent replies with this fixed text regardless of the prompt.
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

// Regression for shadcn-ui/ui#11181: in a reopened session (mount-time anchors were never
// registered), the loader -> assistant row swap at stream start must not re-anchor a
// historical turn.
test('does not re-anchor a historical turn when the reply row replaces the loader', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  // Build history taller than the viewport.
  for (let turn = 0; turn < 6; turn += 1) {
    await textbox.fill(`Turn ${turn}: ${USER_MESSAGE}`)
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(turn + 1)
  }

  // Reopen: the restored transcript's anchors mount unregistered.
  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: `Turn 0: ${USER_MESSAGE}` })
    .click()
  const reopenedConversation = page.getByRole('region', { name: 'Conversation' })
  await expect(reopenedConversation.getByText(AGENT_REPLY).first()).toBeAttached()

  // Send a new turn: user anchor + loader append, then the reply row swaps the loader.
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(`Reopened: ${USER_MESSAGE}`)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()
  // The 7th anchor row exists immediately; the loader -> reply swap happens during this settle
  // window. (Reply text counts flap while restored messages re-present, so don't wait on them.)
  await expect(
    reopenedConversation.locator('[data-slot="message-scroller-item"][data-scroll-anchor="true"]')
  ).toHaveCount(7)
  await page.waitForTimeout(1500)

  // The viewport top must sit near the NEW turn's anchor, not a historical one.
  const anchorTops = await reopenedConversation
    .locator('[data-slot="message-scroller-item"][data-scroll-anchor="true"]')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top))
  const viewportTop = await reopenedConversation.evaluate(
    (element) => element.getBoundingClientRect().top
  )
  expect(anchorTops.length).toBe(7)
  const newAnchorDistance = Math.abs(anchorTops[anchorTops.length - 1] - viewportTop)
  const oldestAnchorDistance = Math.abs(anchorTops[0] - viewportTop)
  expect(newAnchorDistance).toBeLessThan(oldestAnchorDistance)
})
