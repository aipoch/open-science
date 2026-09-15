import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

const resourceName = (url: string): string => new URL(url).pathname.split('/').at(-1) ?? url

test('loads Markdown presentation chunks only when their surfaces first open', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const requestedResources = new Set<string>()
  page.on('request', (request) => requestedResources.add(resourceName(request.url())))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
      )
  )

  expect(
    [...requestedResources].filter((resource) =>
      /^(?:AgentMarkdown|GlobalSearchDialog|UpdateDialog)-.*\.js$/u.test(resource)
    )
  ).toEqual([])

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const searchDialog = page.getByRole('dialog', { name: 'Global search' })
  const searchInput = searchDialog.getByRole('combobox', { name: 'Global search' })
  await expect(searchDialog).toBeVisible()
  await expect(searchInput).toBeFocused()
  await expect
    .poll(() => [...requestedResources])
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
    .poll(() => [...requestedResources])
    .toEqual(expect.arrayContaining([expect.stringMatching(/^UpdateDialog-.*\.js$/)]))
})
