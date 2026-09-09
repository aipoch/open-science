import { readFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

test('upgrades isolated historical workspace, conversation and attachment through actual startup', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Historical brand migration')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  const content = '# Preserved research\n\nMigration keeps the complete attachment.'
  await page
    .locator('input[type="file"][multiple]')
    .setInputFiles({ name: 'history.md', mimeType: 'text/markdown', buffer: Buffer.from(content) })
  await expect(page.getByRole('button', { name: 'Remove attachment history.md' })).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Remember this historical experiment.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  const migrated = await app.restartWithLegacyBrandPaths()
  page = migrated.page
  expect(migrated.identityAfter).toEqual(migrated.identityBefore)
  expect((await lstat(migrated.oldRoot)).isSymbolicLink()).toBe(true)
  expect(await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)).toBe(
    migrated.newRoot
  )
  await expect(
    page.getByText('Remember this historical experiment.', { exact: true }).first()
  ).toBeVisible()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /Remember this historical experiment/ })
    .click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: 'Preview uploaded file history.md' }).click()
  const preview = page.getByRole('dialog', { name: 'Preview history.md' })
  await expect(preview.getByText('Preserved research', { exact: true })).toBeVisible()
  await expect(
    preview.getByText('Migration keeps the complete attachment.', { exact: true })
  ).toBeVisible()
  const storageRoot = dirname(migrated.newRoot)
  const receipt = JSON.parse(
    await readFile(join(`${storageRoot}.brand-migration`, 'journal.json'), 'utf8')
  )
  expect(receipt.status).toBe('committed')
  expect(receipt.database.tables).toBeGreaterThan(50)
  await preview.getByRole('button', { name: 'Close preview of history.md' }).click()
  page = await app.restart()
  await expect(
    page.getByText('Remember this historical experiment.', { exact: true }).first()
  ).toBeVisible()
})
