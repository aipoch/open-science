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

for (const language of ['en', 'zh-Hans']) {
  test(`reviews risky code without duplicate header information (${language})`, async ({
    page
  }, testInfo) => {
    const chinese = language === 'zh-Hans'
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const light of [true, false]) {
      await page.goto(`/web-permission.html?risk=1&lang=${language}${light ? '&light=1' : ''}`)
      const review = page.getByTestId('notebook-code-review')
      await expect(page.getByTestId('permission-header')).toHaveText(
        chinese ? '检查高风险代码' : 'Review risky code'
      )
      await expect(page.getByTestId('permission-impact-info')).toHaveCount(0)
      await expect(page.getByTestId('permission-category-badge')).toHaveCount(0)
      await expect(page.getByTestId('scope-chevron')).toHaveCount(0)
      await expect(review.locator('li')).toHaveCount(1)
      await expect(review.locator('li')).toContainText('os.unlink(a_path)')
      await expect(review.locator('[data-code-line="9"]')).toHaveAttribute(
        'data-highlighted',
        'true'
      )
      await expect(review.locator('[data-code-line="9"]')).toContainText('os.unlink(a_path)')
      await expect(review.locator('[data-line="9"]')).toBeVisible()
      await expect(review.getByTestId('tool-code-block')).toHaveAttribute('data-language', 'python')
      await expect(review.locator('details')).not.toHaveAttribute('open')
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 850 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        )
        await page.screenshot({
          path: testInfo.outputPath(`risk-${language}-${light ? 'light' : 'dark'}-${width}.png`),
          fullPage: true,
          animations: 'disabled'
        })
      }
      const details = review.locator('summary')
      await details.focus()
      await page.keyboard.press('Enter')
      await expect(review.locator('details')).toHaveAttribute('open', '')
      await expect(review.getByText('default-python', { exact: true })).toBeVisible()
      await expect(review).not.toContainText('/workspace/open-science/')
      await details.press('Enter')
      const optionId = light ? 'allow-once' : 'deny'
      await page
        .getByRole('button', {
          name: light ? (chinese ? '允许一次' : 'Allow once') : chinese ? '拒绝' : 'Deny',
          exact: true
        })
        .click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { webPermissionResponses: unknown[] }).webPermissionResponses
          )
        )
        .toEqual([{ requestId: 'code-risk', optionId }])
    }
  })
}

test('reveals a risky line inside a long code block without scrolling the conversation', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 768, height: 850 })
  await page.goto('/web-permission.html?risk=1&long=1&light=1')
  const review = page.getByTestId('notebook-code-review')
  const block = review.getByTestId('tool-code-block')
  const line = block.locator('[data-code-line="57"]')
  await expect(line).toHaveAttribute('data-highlighted', 'true')
  expect(await block.evaluate((element) => element.scrollTop)).toBe(0)
  const scrollY = await page.evaluate(() => window.scrollY)
  await review.getByRole('button', { name: 'Line 57', exact: true }).click()
  await expect(line).toBeFocused()
  expect(await block.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const bounds = await block.boundingBox()
  const target = await line.boundingBox()
  expect(target!.y).toBeGreaterThanOrEqual(bounds!.y)
  expect(target!.y + target!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
  await page.screenshot({ path: testInfo.outputPath('risk-reveal-line.png'), fullPage: true })
})

for (const [state, label] of [
  ['declined', 'declined by you'],
  ['allowed', 'Allowed once'],
  ['closed', 'request ended']
]) {
  test(`shows a compact ${state} code-review receipt in the message`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 650 })
    await page.goto(`/web-permission.html?receipt=${state}&light=1`)
    const row = page.getByTestId('tool-chip').filter({ hasText: 'Code risk review' })
    await expect(row).toHaveText(`Code risk review·os.unlink${label}`)
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('permission-header')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath(`receipt-${state}-collapsed.png`),
      fullPage: true
    })
    await row.click()
    const receipt = page.getByTestId('notebook-code-review-receipt')
    await expect(receipt).toBeVisible()
    await expect(receipt).not.toContainText('notebookCodeRisk')
    await expect(receipt.locator('[data-code-line="9"]')).toHaveAttribute(
      'data-highlighted',
      'true'
    )
    await expect(receipt.locator('details')).not.toHaveAttribute('open')
    await receipt.getByRole('button', { name: 'Line 9', exact: true }).click()
    await expect(receipt.locator('[data-code-line="9"]')).toBeFocused()
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath(`receipt-${state}-expanded.png`),
      fullPage: true
    })
    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'false')
  })
}
