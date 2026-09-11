import { expect, test } from '@playwright/test'

test('shows local changes before replacement and cancellation makes no import call', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/extensions-permissions.html')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'citation.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('fixture archive')
  })
  await expect(page.getByText('Replace imported-citation')).toBeVisible()
  await page.getByText('File changes: +1 / ~1 / −1').click()
  await expect(page.getByText('− local-notes.txt', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Preview Citation' }).click()
  await expect(page.getByRole('dialog')).toContainText('including local edits')
  await page.getByRole('button', { name: 'Close preview' }).click()
  await page.getByRole('button', { name: 'Choose different files', exact: true }).click()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { extensionRegression: { imports: unknown[] } }).extensionRegression
          .imports
    )
  ).toEqual([])
})

test('revokes session approval while showing the remaining global approval', async ({ page }) => {
  await page.goto('/extensions-permissions.html')
  await page.getByRole('button', { name: 'Permissions fixture' }).click()
  await expect(page.getByText('Also allowed globally')).toBeVisible()
  await expect(page.getByText('Approval time unknown')).toBeVisible()
  await page.getByRole('button', { name: /Revoke .*Session: Analysis/ }).click()
  await expect(page.locator('[data-slot="permission-row"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="permission-row"]')).toContainText('Global')
  await expect(page.locator('[data-slot="permission-row"]')).toContainText('Approved ')
})
