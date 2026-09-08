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
  await search.getByRole('combobox', { name: 'Global search' }).press('Enter')
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

test('previews a recent upload without leaving search and locates its source message from the corner action', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await suppressWorkspaceStarNudge(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'New project' })
  await create.getByLabel('Name').fill('Recent upload navigation')
  await create.getByRole('button', { name: 'Create project' }).click()
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'source-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Source notes\n\nThe file opens in a large preview.')
  })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Read the source notes.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Global search' })
  await search.locator('[data-category="sessions"]').click()
  await search.getByRole('listbox').getByRole('option').first().click()
  await search.locator('.search-recent-file-open').filter({ hasText: 'source-notes.md' }).click()
  const preview = page.getByRole('dialog', { name: 'Preview source-notes.md' })
  await expect(preview.getByText('The file opens in a large preview.')).toBeVisible()
  await preview.getByRole('button', { name: 'Close preview of source-notes.md' }).click()
  await expect(preview).toBeHidden()
  await expect(search).toBeVisible()
  const locate = search.getByRole('button', { name: 'View in context for source-notes.md' })
  await locate.hover()
  await expect(page.getByRole('tooltip', { name: 'Jump to message' })).toBeVisible()
  await search.screenshot({ path: testInfo.outputPath('recent-file-locate.png') })
  await locate.click()
  await expect(search).toBeHidden()
  const sourceMessage = page
    .locator('[data-message-id]')
    .filter({ hasText: 'Read the source notes.' })
    .first()
  await expect(sourceMessage).toBeInViewport()
  await expect
    .poll(() => page.locator('#root').evaluate((root) => (root as HTMLElement).inert))
    .toBe(false)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Still responsive')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toContainText(
    'Still responsive'
  )
})
