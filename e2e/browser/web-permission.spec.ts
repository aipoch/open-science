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

test('approves conversation web reading and captures the Chinese scope card', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 450 })
  await page.goto('/web-permission.html?lang=zh-Hans')
  await expect(
    page.getByText('会话授权允许本会话及其子智能体读取不同网站的网页。', { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('web-reading-zh-Hans.png') })
  await page.getByRole('button', { name: '选择授权范围' }).click()
  await page.screenshot({ path: testInfo.outputPath('web-reading-scopes-zh-Hans.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /允许.*对话|允许.*会话/ }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
      )
    )
    .toEqual([{ requestId: 'web-read', optionId: 'session' }])
})
