import { expect, test } from '@playwright/test'

test('stacks the folder access title above smaller copy and keeps confirmation within the viewport', async ({
  page
}) => {
  await page.goto('/extensions-permissions.html')
  await page.getByRole('button', { name: 'Permissions fixture' }).click()
  const toggle = page.getByRole('switch', { name: 'Restrict Notebook and Shell folders' })
  await toggle.click()
  const dialog = page.getByRole('alertdialog', { name: 'Allow broader folder access?' })
  await expect(dialog).toBeVisible()

  for (const width of [900, 375]) {
    await page.setViewportSize({ width, height: 700 })
    await expect(async () => {
      const layout = await dialog.evaluate((element) => {
        const title = document.getElementById(element.getAttribute('aria-labelledby')!)!
        const description = document.getElementById(element.getAttribute('aria-describedby')!)!
        const heading = title.getBoundingClientRect()
        const copy = description.getBoundingClientRect()
        const panel = element.getBoundingClientRect()
        return {
          titleBottom: heading.bottom,
          titleHeight: heading.height,
          titleLineHeight: Number.parseFloat(getComputedStyle(title).lineHeight),
          titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
          descriptionTop: copy.top,
          descriptionSize: Number.parseFloat(getComputedStyle(description).fontSize),
          left: panel.left,
          right: panel.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth
        }
      })
      expect(layout.descriptionTop).toBeGreaterThanOrEqual(layout.titleBottom)
      expect(layout.descriptionSize).toBeLessThan(layout.titleSize)
      expect(layout.titleHeight).toBeLessThanOrEqual(layout.titleLineHeight + 1)
      expect(layout.left).toBeGreaterThanOrEqual(0)
      expect(layout.right).toBeLessThanOrEqual(width)
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
    }).toPass()
  }

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await dialog.getByRole('button', { name: 'Allow broader folder access', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(toggle).not.toBeChecked()
})

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
  await expect(page.getByText('Added time unknown')).toBeVisible()
  await page.getByRole('button', { name: /Revoke .*Session: Analysis/ }).click()
  await expect(page.locator('[data-slot="permission-row"]')).toHaveCount(1)
  await expect(page.locator('[data-slot="permission-row"]')).toContainText('Global')
  await expect(page.locator('[data-slot="permission-row"]')).toContainText('Added ')
})
