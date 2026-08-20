import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Tool layout stability project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'
const TOOL_LAYOUT_SHIFT_PROMPT = 'Run the tool layout stability journey.'

test.use({ windowMode: 'normal' })

test('keeps a completed tool group stationary when final Markdown starts rendering', async ({
  app
}) => {
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

  await textbox.fill(USER_MESSAGE)
  await sendButton.click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await textbox.fill(TOOL_LAYOUT_SHIFT_PROMPT)
  await sendButton.click()

  const toolGroup = conversation.locator('[data-message-id="activity-group-e2e-layout-tool-1"]')
  await expect(toolGroup).toBeVisible()

  const tops = await toolGroup.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const observations: number[] = []
        const startedAt = performance.now()
        const sample = (): void => {
          observations.push(element.getBoundingClientRect().top)
          if (performance.now() - startedAt >= 2_000) {
            resolve(observations)
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
  )

  await expect(conversation.getByText('Layout fixture complete.', { exact: true })).toBeVisible()

  const excursion = Math.max(...tops) - Math.min(...tops)
  expect(
    excursion,
    JSON.stringify({
      firstTop: tops[0],
      minimumTop: Math.min(...tops),
      maximumTop: Math.max(...tops),
      finalTop: tops.at(-1)
    })
  ).toBeLessThanOrEqual(2)
})
