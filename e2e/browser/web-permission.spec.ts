import { expect, test } from '@playwright/test'

test('shows the web-reading scope and keeps Once available', async ({ page }) => {
  await page.goto('/web-permission.html')
  await expect(page.getByText('Allow web reading?', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'Conversation approval allows web reading across websites for this conversation and its subagents.',
      { exact: true }
    )
  ).toBeVisible()
  await page.getByRole('button', { name: 'Choose authorization scope' }).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(2)
  await page.getByRole('menuitemradio', { name: /Once/ }).click()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
      )
    )
    .toEqual([{ requestId: 'web-read', optionId: 'once' }])
})

test('approves conversation web reading and captures the scope card', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 450 })
  await page.goto('/web-permission.html')
  await expect(
    page.getByText(
      'Conversation approval allows web reading across websites for this conversation and its subagents.',
      { exact: true }
    )
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('web-reading.png') })
  await page.getByRole('button', { name: 'Choose authorization scope' }).click()
  await page.screenshot({ path: testInfo.outputPath('web-reading-scopes.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Allow for this conversation', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
      )
    )
    .toEqual([{ requestId: 'web-read', optionId: 'session' }])
})

test('offers conversation search approval with the scope visible', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 550 })
  await page.goto('/web-permission.html?search=1')
  await expect(
    page.getByTestId('permission-header').getByText('Allow web search?', { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(
      'Conversation approval allows text searches on the web for this conversation and its subagents.',
      { exact: true }
    )
  ).toBeVisible()
  await page.getByRole('button', { name: 'Choose authorization scope' }).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('web-search-scopes.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Allow for this conversation', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
      )
    )
    .toEqual([{ requestId: 'web-search', optionId: 'session' }])
})
