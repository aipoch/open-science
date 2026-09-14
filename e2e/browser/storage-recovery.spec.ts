import { expect, test } from '@playwright/test'

test('storage rejection preserves input and adoption can retry at a narrow viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 700, height: 500 })
  await page.goto('/storage-recovery.html')
  await expect(
    page.getByText('Cleanup from an earlier move is still pending.', { exact: false })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Session workspaces', exact: true }).click()
  await expect(page.getByText('Retained after deletion')).toBeVisible()
  await page.getByRole('button', { name: 'Change location', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Browse…', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Could not check this folder. Try again.')
  await expect(page.getByLabel('New location')).toHaveValue('/candidate')
  await page.getByRole('button', { name: 'Browse…', exact: true }).click()
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Use this folder', exact: true })
    .click()
  await expect(page.getByRole('alert')).toHaveText('Could not switch to this folder.')
  await expect(page.getByLabel('New location')).toHaveValue('/candidate')
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Use this folder', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'Switching…', exact: true })).toBeDisabled()
  await expect(page.getByLabel('New location')).toBeDisabled()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { storageRegression: { adoptions: number } }).storageRegression
          .adoptions
    )
  ).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})
