import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Agent journey project'
const USER_MESSAGE = 'Summarize the deterministic fixture.'
const EDITED_USER_MESSAGE = 'Summarize the revised deterministic fixture.'
const AGENT_REPLY = `Deterministic reply: ${USER_MESSAGE}`
const PERMISSION_PROMPT = 'Request fixture permission.'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('edits and navigates message revisions that persist after relaunch', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message' }).click()

  let conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await conversation.getByText(USER_MESSAGE, { exact: true }).hover()
  await conversation.getByRole('button', { name: 'Edit message' }).click()
  await conversation.getByRole('textbox', { name: 'Edit message' }).fill(EDITED_USER_MESSAGE)
  await conversation.getByRole('button', { name: 'Send', exact: true }).click()

  const revision = conversation.getByLabel('Message revision', { exact: true })
  const previousRevision = conversation.getByRole('button', {
    name: 'Previous message revision'
  })
  const nextRevision = conversation.getByRole('button', { name: 'Next message revision' })
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('2/2')
  await expect(previousRevision).toBeEnabled()
  await expect(nextRevision).toBeDisabled()

  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('1/2')
  await expect(previousRevision).toBeDisabled()
  await expect(nextRevision).toBeEnabled()

  await nextRevision.click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('2/2')
  await previousRevision.click()
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(revision).toHaveText('1/2')

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: USER_MESSAGE })
    .click()
  conversation = page.getByRole('region', { name: 'Conversation' })
  await expect(conversation.getByText(USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByText(AGENT_REPLY, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('1/2')
  await expect(
    conversation.getByRole('button', { name: 'Previous message revision' })
  ).toBeDisabled()
  await expect(conversation.getByRole('button', { name: 'Next message revision' })).toBeEnabled()

  await conversation.getByRole('button', { name: 'Next message revision' }).click()
  await expect(conversation.getByText(EDITED_USER_MESSAGE, { exact: true })).toBeVisible()
  await expect(conversation.getByLabel('Message revision', { exact: true })).toHaveText('2/2')
})

test('resolves Agent permission requests through both Allow and Deny decisions', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(`${PERMISSION_PROMPT} allow`)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Allow/ }).click()
  await expect(page.getByText('Fixture permission allowed.', { exact: true })).toBeVisible()

  await composer.fill(`${PERMISSION_PROMPT} deny`)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()
})

test('archives a completed session from its sidebar actions', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  const archive = page.getByRole('menuitem', { name: 'Archive' })
  await expect(archive).toBeEnabled()
  await archive.click()

  await expect(page.getByTestId('archive-undo-snackbar')).toContainText('Archived session')
  await expect(page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` })).toBeHidden()
})
