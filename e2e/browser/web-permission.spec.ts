import { expect, test } from '@playwright/test'

test('withdraws a cancelled network approval on an incremental state update', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 550 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/web-permission.html?network=1')
  const approval = page.getByTestId('permission-header')
  await expect(approval).toBeVisible()
  await expect(approval).toContainText('tcga-xena-hub.s3.us-east-1.amazonaws.com')
  await page.screenshot({
    path: testInfo.outputPath('network-approval-pending.png'),
    fullPage: true,
    animations: 'disabled'
  })
  await page.evaluate(() =>
    (window as unknown as { cancelNetworkApproval: () => void }).cancelNetworkApproval()
  )
  await expect(approval).toHaveCount(0)
  await expect(page.getByTestId('network-approval-fixture')).not.toContainText(
    'tcga-xena-hub.s3.us-east-1.amazonaws.com'
  )
  await expect(page.getByRole('heading', { name: 'TCGA-XENA' })).toBeInViewport({ ratio: 1 })
  await page.screenshot({
    path: testInfo.outputPath('network-approval-cancelled.png'),
    fullPage: true,
    animations: 'disabled'
  })
  expect(
    await page.evaluate(
      () => (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
    )
  ).toEqual([])
})

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
