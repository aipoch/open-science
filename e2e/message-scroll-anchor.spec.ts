import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Scroll anchor project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const PERMISSION_PROMPT = 'Request fixture permission.'
// The fake agent replies with this fixed text regardless of the prompt.
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

test('anchors a newly sent user message near the top of the viewport', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  // Build a transcript taller than the viewport so a non-anchored send would pin to the bottom.
  for (let turn = 0; turn < 5; turn += 1) {
    await textbox.fill(`Turn ${turn}: ${USER_MESSAGE}`)
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    // Replies share one fixed text, so count completed reply rows to sequence turns.
    await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(turn + 1)
  }

  const userRow = conversation
    .locator('[data-slot="message-scroller-item"][data-scroll-anchor="true"]')
    .last()
  await expect(userRow).toBeVisible()
  // Give the scroller a moment to settle anchoring before measuring.
  await page.waitForTimeout(500)

  const viewportBox = await conversation.boundingBox()
  const userRowBox = await userRow.boundingBox()
  expect(viewportBox).not.toBeNull()
  expect(userRowBox).not.toBeNull()

  const offsetFromViewportTop = userRowBox!.y - viewportBox!.y
  // Anchored near the top: allow the 64px previous-item peek plus paddings.
  expect(offsetFromViewportTop).toBeLessThan(160)
})

test('keeps the prompt fixed while a blocking panel covers and leaves the transcript', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(`${PROJECT_NAME} permission`)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })
  const sendButton = page.getByRole('button', { name: 'Send message' })

  for (let turn = 0; turn < 5; turn += 1) {
    await textbox.fill(`Turn ${turn}: ${USER_MESSAGE}`)
    await sendButton.click()
    await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(turn + 1)
  }

  const viewportHeightBefore = await conversation.evaluate((element) => element.clientHeight)
  await textbox.fill(`${PERMISSION_PROMPT} preserve the prompt anchor`)
  await sendButton.click()
  await expect(page.getByTestId('permission-composer')).toBeVisible()

  const promptRow = conversation
    .locator('[data-slot="message-scroller-item"][data-scroll-anchor="true"]')
    .last()
  await expect(promptRow).toBeVisible()
  const readPromptOffset = async (): Promise<number> => {
    const viewportBox = await conversation.boundingBox()
    const promptBox = await promptRow.boundingBox()
    expect(viewportBox).not.toBeNull()
    expect(promptBox).not.toBeNull()
    return promptBox!.y - viewportBox!.y
  }

  const offsetWhileBlocked = await readPromptOffset()
  expect(await conversation.evaluate((element) => element.clientHeight)).toBe(viewportHeightBefore)

  await page.getByRole('button', { name: /^Allow/ }).click()
  await expect(page.getByText('Fixture permission allowed.', { exact: true })).toBeVisible()
  await expect(page.getByTestId('permission-composer')).toBeHidden()

  const offsetAfterApproval = await readPromptOffset()
  expect(Math.abs(offsetAfterApproval - offsetWhileBlocked)).toBeLessThanOrEqual(2)
})
