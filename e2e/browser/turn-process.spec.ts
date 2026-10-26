import { expect, test } from '@playwright/test'

test('completed turn can expand and collapse with keyboard while retaining the final reply', async ({
  page
}) => {
  await page.goto('/turn-process.html')
  const toggle = page.getByRole('button', { name: '2 previous steps', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByText('I’ll check the data structure and missing values first.')
  ).toHaveCount(0)
  await expect(page.getByText('Data checks are complete.', { exact: true })).toBeVisible()
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page.getByText('I’ll check the data structure and missing values first.')
  ).toBeVisible()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('failed turn retains the error and last partial output outside its disclosure', async ({
  page
}) => {
  await page.goto('/turn-process.html?failed')
  await expect(
    page.getByRole('button', { name: '2 previous steps Failed', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('alert')).toContainText('The analysis service disconnected.')
  await expect(page.getByText('These results are partial. Reconnect and try again.')).toBeVisible()
})

test('running turn expands its process and removes the completed disclosure', async ({ page }) => {
  await page.goto('/turn-process.html')
  await expect(page.getByRole('button', { name: '2 previous steps', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Running', exact: true }).click()
  await expect(page.getByRole('button', { name: '2 previous steps', exact: true })).toHaveCount(0)
  await expect(
    page.getByText('I’ll check the data structure and missing values first.')
  ).toBeVisible()
})

test('search reveals a folded intermediate message across the transcript window', async ({
  page
}) => {
  await page.goto('/turn-process.html?long')
  await expect(page.getByRole('button', { name: '120 previous steps', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Find intermediate', exact: true }).click()
  await expect(page.getByText('Intermediate step 2', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '120 previous steps', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')
})
