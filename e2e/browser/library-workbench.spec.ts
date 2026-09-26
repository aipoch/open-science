import { expect, test } from '@playwright/test'

for (const width of [320, 375, 414, 768]) {
  for (const dark of [false, true]) {
    test(`Library Preview fits ${width}px in ${dark ? 'dark' : 'light'} mode`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`/library-workbench.html?${dark ? 'dark&' : ''}${width === 375 ? 'zh' : ''}`)
      const row = page.getByRole('button', { name: /Example reference/ })
      await expect(row).toBeVisible()
      await row.focus()
      await page.keyboard.press('Enter')
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      const expand = page.getByRole('button', { name: /^(Show more|Show less|展开|收起)$/ })
      const literature = page.getByRole('button', {
        name: /^(View in Literature|在文献面板中查看)$/
      })
      const expandBounds = await expand.boundingBox()
      const literatureBounds = await literature.boundingBox()
      expect(expandBounds).not.toBeNull()
      expect(literatureBounds).not.toBeNull()
      // Navigation is directly available beside the row actions, above the expanded abstract.
      expect(literatureBounds!.y).toBeLessThan(expandBounds!.y)
      await expand.click()
      await expect(expand).toHaveAttribute('aria-expanded', 'true')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      const overflows = await page
        .locator('section')
        .evaluate(
          (root) =>
            [...root.querySelectorAll<HTMLElement>('button, input, select')].filter(
              (element) => element.getBoundingClientRect().right > innerWidth + 1
            ).length
        )
      expect(overflows).toBe(0)
      await page.screenshot({
        path: testInfo.outputPath(`library-${width}-${dark ? 'dark' : 'light'}.png`)
      })
      expect(errors).toEqual([])
    })
  }
}

test('empty states offer recovery and hidden preview performs no reads', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('/library-workbench.html?mode=empty')
  await expect(page.getByText('No references in this project', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Browse all references' }).click()
  await expect(page.getByText('Your library is empty', { exact: true })).toBeVisible()
  await page.getByRole('searchbox').fill('missing')
  await expect(page.getByText('No matching references', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(page.getByText('Your library is empty', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Toggle preview visibility' }).click()
  const counts = await page.evaluate(() =>
    (
      window as unknown as {
        libraryFixture: { counts: () => { reads: number; subscriptions: number } }
      }
    ).libraryFixture.counts()
  )
  expect(counts.subscriptions).toBe(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect(
    await page.evaluate(() =>
      (window as unknown as { libraryFixture: { counts: () => unknown } }).libraryFixture.counts()
    )
  ).toEqual(counts)
  await page.getByRole('button', { name: 'Toggle preview visibility' }).click()
  await expect(page.getByText('Your library is empty', { exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { libraryFixture: { counts: () => { reads: number } } }
        ).libraryFixture.counts().reads
    )
  ).toBe(counts.reads + 1)
})

test('conversation search opens in place and supports keyboard selection among many sessions', async ({
  page
}) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.goto('/library-workbench.html')
  await page.getByRole('button', { name: 'Choose another conversation' }).click()
  const search = page.getByRole('combobox', { name: 'Search conversations' })
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(10)
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByRole('option')).toHaveCount(20)
  await search.fill('#35')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.press('Enter')
  await expect(search).not.toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'session-34:' })).toBeVisible()
})

test('row actions explain their purpose on hover without reopening after pointer dismissal', async ({
  page
}) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.goto('/library-workbench.html')
  for (const [name, description] of [
    ['Reference details', 'Reference details'],
    ['Copy title', 'Copy title'],
    ['Add to chat', 'Add references to the current conversation draft'],
    ['Choose another conversation', 'Choose another conversation'],
    ['View in Literature', 'View in Literature']
  ]) {
    await page.getByRole('button', { name, exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText(description)
    await page.mouse.move(10, 400, { steps: 10 })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
  const choose = page.getByRole('button', { name: 'Choose another conversation' })
  await choose.click()
  await expect(page.getByRole('combobox')).toBeFocused()
  await page.getByRole('searchbox').click()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  // Wait beyond the tooltip delay to catch focus-return reopening.
  await page.waitForTimeout(400)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add to chat', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tooltip')).toHaveText('Choose another conversation')
})
