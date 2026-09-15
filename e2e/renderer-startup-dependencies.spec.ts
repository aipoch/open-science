import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const loadedRendererResources = async (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname.split('/').at(-1) ?? entry.name)
  )

test('loads Markdown presentation chunks only when their surfaces first open', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
      )
  )

  const startupResources = await loadedRendererResources(page)
  expect(
    startupResources.filter((resource) =>
      /^(?:AgentMarkdown|GlobalSearchDialog|UpdateDialog)-.*\.js$/u.test(resource)
    )
  ).toEqual([])

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const searchDialog = page.getByRole('dialog', { name: 'Global search' })
  const searchInput = searchDialog.getByRole('combobox', { name: 'Global search' })
  await expect(searchDialog).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect
    .poll(() => loadedRendererResources(page))
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AgentMarkdown-.*\.js$/),
        expect.stringMatching(/^GlobalSearchDialog-.*\.js$/)
      ])
    )
  await searchInput.press('Escape')
  await expect(searchDialog).toBeHidden()

  await app.emitUpdateStatus({
    state: 'available',
    current: '0.30.0',
    latest: '0.31.0',
    notes: '## Deferred release notes'
  })
  const updateCapsule = page.getByRole('button', {
    name: 'New version: Update (v0.31.0)'
  })
  await expect(updateCapsule).toBeVisible()
  await updateCapsule.click()
  const updateDialog = page.getByRole('dialog', { name: 'Update available' })
  await expect(updateDialog).toBeVisible()
  await expect(updateDialog).toContainText('Deferred release notes')
  await expect
    .poll(() => loadedRendererResources(page))
    .toEqual(expect.arrayContaining([expect.stringMatching(/^UpdateDialog-.*\.js$/)]))
})
