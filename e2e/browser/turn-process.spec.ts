import { expect, test } from '@playwright/test'

test('completed turn can expand and collapse with keyboard while retaining the final reply', async ({
  page
}) => {
  await page.goto('/turn-process.html')
  const toggle = page.getByRole('button', { name: '2 previous messages', exact: true })
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
    page.getByRole('button', { name: '2 previous messages Failed', exact: true })
  ).toHaveAttribute('aria-expanded', 'false')
  const notice = page.getByTestId('composer-notice-slot')
  await expect(notice.getByRole('alert')).toContainText('An unexpected application error occurred')
  await expect(notice.locator('pre')).toBeHidden()
  await notice.locator('summary').click()
  await expect(notice.locator('pre')).toContainText('The analysis service disconnected.')
  await expect(page.getByText('These results are partial. Reconnect and try again.')).toBeVisible()
})

test('running turn expands its process and removes the completed disclosure', async ({ page }) => {
  await page.goto('/turn-process.html')
  await expect(page.getByRole('button', { name: '2 previous messages', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Running', exact: true }).click()
  await expect(page.getByRole('button', { name: '2 previous messages', exact: true })).toHaveCount(
    0
  )
  await expect(
    page.getByText('I’ll check the data structure and missing values first.')
  ).toBeVisible()
})

test('search reveals a folded intermediate message across the transcript window', async ({
  page
}) => {
  await page.goto('/turn-process.html?long')
  await expect(
    page.getByRole('button', { name: '120 previous messages', exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Find intermediate', exact: true }).click()
  await expect(page.getByText('Intermediate step 2', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '120 previous messages', exact: true })
  ).toHaveAttribute('aria-expanded', 'true')
})

test('sending from history preserves the reading position until the end button is clicked', async ({
  page
}) => {
  await page.goto('/turn-process.html?history')
  const viewport = page.getByRole('region', { name: 'Conversation' })
  const end = page.getByRole('button', { name: 'Scroll to end' })
  await viewport.hover()
  await page.mouse.wheel(0, -10000)
  await expect(end).toBeVisible()
  const scrollTop = (): Promise<number> => viewport.evaluate((node) => node.scrollTop)
  await expect.poll(scrollTop).toBe(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const dots = end.locator('[aria-hidden="true"] > span')
  await expect(dots).toHaveCount(3)
  await expect(viewport.locator('[data-message-id="new-prompt"]')).toBeAttached()
  expect(await scrollTop()).toBe(0)
  await page.getByRole('button', { name: 'Finish' }).click()
  await expect(end.locator('svg')).toBeVisible()
  expect(await scrollTop()).toBe(0)
  await end.click()
  await expect(end).toHaveAttribute('data-active', 'false')
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThanOrEqual(1)
})
