import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// Pacing must actually run: hidden windows emulate reduced motion (instant commits), so this
// journey needs a normal window with live animation frames.
test.use({ windowMode: 'normal' })

const PROJECT_NAME = 'Queue presentation gate project'
const WARMUP_PROMPT = 'Summarize the deterministic fixture.'
const GATE_PROMPT = 'Hold the queue until the reveal finishes.'
const FOLLOW_UP = 'Follow-up after the reveal.'
// The fake agent replies with this fixed text for any prompt without a journey route.
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

test('holds the queued message until the previous reply finishes revealing', async ({ app }) => {
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

  // Warm-up turn: queueing during a brand-new conversation's first turn is a separate flow;
  // the presentation race this spec covers happens on an established session.
  await textbox.fill(WARMUP_PROMPT)
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toHaveCount(1)

  await textbox.fill(GATE_PROMPT)
  await expect(sendButton).toBeEnabled()
  await sendButton.click()

  // Queue a follow-up while the gated turn is still streaming.
  const queueSubmit = page.getByTestId('composer-queue-submit')
  await expect(queueSubmit).toBeVisible()
  await textbox.fill(FOLLOW_UP)
  await queueSubmit.click()
  const queueTrigger = page.getByTestId('composer-queue-trigger')
  await expect(queueTrigger).toBeVisible()

  // The fake agent's stream ends almost immediately (the session goes idle), but the giant
  // final chunk keeps the paced reveal busy for seconds afterwards. Well past store-complete
  // the follow-up must still be queued — an ungated queue dispatches the moment the session
  // turns idle, mid-reveal.
  await page.waitForTimeout(2000)
  await expect(queueTrigger).toBeVisible()
  await expect(conversation.getByText(FOLLOW_UP)).toHaveCount(0)

  // Once the reveal settles, the queue drains and the follow-up turn completes.
  await expect(conversation.getByText(FOLLOW_UP)).toBeVisible({ timeout: 30000 })
  await expect(conversation.getByText(AGENT_REPLY, { exact: true }).last()).toBeVisible()
})
