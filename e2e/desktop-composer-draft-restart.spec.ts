import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'

test.use({ windowMode: 'normal' })

test('keeps an unsent desktop draft across process restarts and persists clearing it', async ({
  app
}) => {
  test.setTimeout(180_000)
  let page = await app.completeOnboarding()
  const project = 'Durable desktop draft'
  await createProjectViaUi(page, project)
  const text = 'Unsent draft survives an application update and restart.'
  await page.getByRole('textbox', { name: 'Ask anything', exact: true }).fill(text)
  for (let restart = 0; restart < 2; restart++) {
    page = await app.restart()
    await page.getByRole('button', { name: project, exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Ask anything', exact: true })).toHaveText(text)
  }
  await page.getByRole('textbox', { name: 'Ask anything', exact: true }).fill('')
  page = await app.restart()
  await page.getByRole('button', { name: project, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask anything', exact: true })).toBeEmpty()
})
