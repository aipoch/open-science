import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

test('runs and shuts down a Notebook session through its packaged MCP boundary', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notebook lifecycle evidence')
  await sendPrompt(page, 'Verify the notebook lifecycle.', 'Notebook lifecycle verified for')

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: 'Verify the notebook lifecycle.' })
    .click()
  await expect(page.getByText('Notebook lifecycle verified for', { exact: false })).toBeVisible()
})
