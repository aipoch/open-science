import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

test('re-enters a persisted provider route through the real Agent process', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Provider bridge evidence')
  await sendPrompt(
    page,
    'Verify the provider bridge.',
    'Provider bridge verified through the Agent process.'
  )

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: 'Verify the provider bridge.' })
    .click()
  await expect(page.getByText('Provider bridge verified through the Agent process.')).toBeVisible()
})
