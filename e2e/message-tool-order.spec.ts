import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Tool order project'
const TOOL_ORDER_PROMPT = 'Run the ordered slow tool journey.'

// The pacing premise needs live animation frames: hidden windows emulate reduced motion,
// which commits streaming content immediately instead of pacing it.
test.use({ windowMode: 'normal' })

// While the intent text is still pacing, the tool card and the loading indicator must
// render in real time (only later text messages wait behind the presentation barrier).
test('shows tool cards and indicators while the intent text is still pacing', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(TOOL_ORDER_PROMPT)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()

  const toolRow = conversation.locator('[data-message-id="activity-group-e2e-order-tool"]')
  await expect(toolRow).toBeVisible()

  // The intent text is still mid-presentation (long text, live pacing).
  const transcriptText = (await conversation.textContent()) ?? ''
  expect(transcriptText).not.toContain('Intent paragraph 29')

  // The tool indicator is visible while the tool runs.
  await expect(conversation.getByText('Interacting with tools')).toBeVisible()

  // DOM order stays timeline-correct: the intent message row precedes the tool row.
  const rowIds = await conversation
    .locator('[data-slot="message-scroller-item"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id') ?? ''))
  const intentIndex = rowIds.findIndex((id) => id.startsWith('message-stream-'))
  const toolIndex = rowIds.indexOf('activity-group-e2e-order-tool')
  expect(intentIndex).toBeGreaterThanOrEqual(0)
  expect(toolIndex).toBeGreaterThan(intentIndex)
})
