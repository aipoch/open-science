import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

test('runs and shuts down a Notebook session through its packaged MCP boundary', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Notebook lifecycle evidence')
  await sendPrompt(page, 'Verify the notebook lifecycle.', 'Notebook lifecycle verified for')

  page = await app.restart()
  await openRecentSession(page, 'Verify the notebook lifecycle.')
  await expect(page.getByText('Notebook lifecycle verified for', { exact: false })).toBeVisible()
})
