import { expect } from '@playwright/test'
import { suppressWorkspaceStarNudge, test } from './fixtures/electron-app'

test('restores app interaction after navigating from a search file preview to its conversation', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await suppressWorkspaceStarNudge(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Search file navigation')
  await create.getByRole('button', { name: 'Create project' }).click()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Create preview context menu artifacts.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Preview context menu artifacts created.', { exact: true })
  ).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Global search' })
  await search.getByRole('combobox', { name: 'Global search' }).fill('context-menu.html')
  await search.locator('[data-category="generated"]').click()
  await search.getByRole('listbox').getByRole('option').click()
  await search.getByRole('button', { name: 'Open file', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Preview context-menu.html' })
  await expect(preview).toBeVisible()
  // A closing surface can leave the DOM without animationend (for example after styles change).
  await page.addStyleTag({
    content:
      '[data-slot="file-preview-dialog"][data-state="closed"] { animation: none !important; }'
  })
  await preview.getByRole('button', { name: 'View in context for context-menu.html' }).click()
  await expect(preview).toBeHidden()
  await expect
    .poll(() => page.locator('#root').evaluate((root) => (root as HTMLElement).inert))
    .toBe(false)
  await expect
    .poll(() => page.locator('body').evaluate((body) => getComputedStyle(body).pointerEvents))
    .toBe('auto')
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill('Interaction restored')
  await expect(composer).toContainText('Interaction restored')
})
