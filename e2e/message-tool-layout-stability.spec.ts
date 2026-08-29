import { expect, type Page } from '@playwright/test'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Tool layout stability project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const AGENT_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'
const TOOL_LAYOUT_SHIFT_PROMPT = 'Run the tool layout stability journey.'
const TOOL_STATUS_LAYOUT_SHIFT_PROMPT = 'Run the status-bearing layout stability journey.'
const BUFFERED_TEXT_TOOL_LAYOUT_SHIFT_PROMPT =
  'Run the buffered text tool layout stability journey.'
const AGENT_STDERR_SUMMARY = 'Agent process stderr: 1 chunk, 22 bytes; raw output omitted.'

const cases = [
  { name: 'without agent status', prompt: TOOL_LAYOUT_SHIFT_PROMPT, agentStatus: undefined },
  {
    name: 'with agent status',
    prompt: TOOL_STATUS_LAYOUT_SHIFT_PROMPT,
    agentStatus: AGENT_STDERR_SUMMARY
  }
] as const

const runLayoutStabilityJourney = async (
  app: {
    completeOnboarding: () => Promise<Page>
    configureFakeAgent: () => Promise<Page>
    showMainWindow: () => Promise<void>
  },
  prompt: string,
  agentStatus?: string
): Promise<void> => {
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

  await textbox.fill(USER_MESSAGE)
  await sendButton.click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-persistence-alert')).toHaveCount(0)
  // Hidden windows complete the first Agent turn reliably on Windows CI. Show the window only
  // before layout sampling so requestAnimationFrame still runs.
  await app.showMainWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await textbox.fill(prompt)
  await sendButton.click()

  const toolGroup = conversation.locator('[data-message-id="activity-group-e2e-layout-tool-1"]')
  await expect(toolGroup).toBeVisible()
  if (agentStatus) {
    await expect(conversation.getByText(agentStatus, { exact: true })).toBeVisible()
  }

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
}

for (const scenario of cases) {
  test(`keeps a completed tool group stationary when final Markdown starts rendering ${scenario.name}`, async ({
    app
  }) => {
    await runLayoutStabilityJourney(app, scenario.prompt, scenario.agentStatus)
  })
}

test('keeps a running tool stationary while one line of buffered Markdown finishes rendering', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const conversation = page.getByRole('region', { name: 'Conversation' })
  const textbox = page.getByRole('textbox', { name: 'Ask anything' })

  await textbox.fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect(page.getByTestId('session-persistence-alert')).toHaveCount(0)
  await app.showMainWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })

  await textbox.fill(BUFFERED_TEXT_TOOL_LAYOUT_SHIFT_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const bufferedMessage = conversation.getByText('Next step.', { exact: true })
  const toolGroup = conversation.locator(
    '[data-message-id="activity-group-e2e-buffered-layout-tool"]'
  )

  await expect(bufferedMessage).toBeVisible()
  await expect(toolGroup).not.toBeVisible()
  await expect(conversation.getByText('Thinking', { exact: true })).toBeVisible()

  const bufferedGeometry = await bufferedMessage.evaluate((element) => {
    const markdown = element.closest<HTMLElement>('.agent-markdown-root')
    const surface =
      markdown?.closest<HTMLElement>('[data-annotation-surface]') ?? markdown?.parentElement
    if (!markdown || !surface) throw new Error('Could not resolve the Agent message surface.')
    return {
      markdownHeight: markdown.getBoundingClientRect().height,
      surfaceHeight: surface.getBoundingClientRect().height
    }
  })
  expect(
    bufferedGeometry.surfaceHeight - bufferedGeometry.markdownHeight,
    JSON.stringify(bufferedGeometry)
  ).toBe(0)

  await expect(toolGroup).toBeVisible()

  const tops = await toolGroup.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const observations: number[] = []
        const startedAt = performance.now()
        const sample = (): void => {
          observations.push(element.getBoundingClientRect().top)
          if (performance.now() - startedAt >= 1_500) {
            resolve(observations)
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
  )

  await expect(bufferedMessage).toBeVisible()

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
