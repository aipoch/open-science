import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

test('re-enters a persisted provider route through the real Agent process', async ({ app }) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Provider bridge evidence')
  await sendPrompt(
    page,
    'Verify the provider bridge.',
    'Provider bridge verified through the Agent process.'
  )

  page = await app.restart()
  await openRecentSession(page, 'Verify the provider bridge.')
  await expect(page.getByText('Provider bridge verified through the Agent process.')).toBeVisible()
})
