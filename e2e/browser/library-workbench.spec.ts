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

test('row actions explain their purpose on hover', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.goto('/library-workbench.html')
  for (const [name, description] of [
    ['Reference details', 'Reference details'],
    ['Copy title', 'Copy title'],
    ['Add to chat', 'Add references to the current conversation draft'],
    ['View in Literature', 'View in Literature']
  ]) {
    await page.getByRole('button', { name, exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveText(description)
    await page.mouse.move(10, 400, { steps: 10 })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
})

test('conversation picker matches PDF hover behavior and preserves click and keyboard use', async ({
  page
}) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.goto('/library-workbench.html')
  const choose = page.getByRole('button', { name: 'Choose another conversation' })
  const search = page.getByRole('combobox', { name: 'Search conversations' })
  const librarySearch = page.getByRole('searchbox')
  await librarySearch.focus()
  await choose.hover()
  await expect(search).toBeVisible()
  await expect(librarySearch).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await search.hover()
  await page.waitForTimeout(250)
  await expect(search).toBeVisible()
  await page.mouse.move(10, 700, { steps: 10 })
  await expect(search).toHaveCount(0)
  await expect(librarySearch).toBeFocused()

  await choose.hover()
  await expect(search).toBeVisible()
  await choose.click()
  await expect(search).toBeFocused()
  await page.mouse.move(10, 700, { steps: 10 })
  await page.waitForTimeout(250)
  await expect(search).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(choose).toBeFocused()
  await choose.press('Enter')
  await expect(search).toBeFocused()
  await search.fill('#35')
  await search.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'session-34:' })).toBeVisible()
})

for (const dark of [false, true]) {
  test(`batch controls opt in and split buttons keep one outline in ${dark ? 'dark' : 'light'} mode`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`/library-workbench.html?${dark ? 'dark' : ''}`)
    await expect(page.getByRole('button', { name: /Example reference/ })).toBeVisible()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    const choose = page.getByRole('button', { name: 'Choose another conversation' })
    const borders = await choose.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
        shadow: style.boxShadow
      }
    })
    expect(borders).toEqual({
      top: '0px',
      right: '0px',
      bottom: '0px',
      left: '1px',
      shadow: 'none'
    })
    await page.getByRole('button', { name: 'Batch actions' }).click()
    await expect(page.getByText('Selected: 0', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Add to chat', exact: true }).first()
    ).toBeDisabled()
    await page.getByRole('checkbox').check()
    await expect(page.getByText('Selected: 1', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add to chat', exact: true }).first().click()
    await expect(page.getByRole('status').filter({ hasText: 'session-0:' })).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Batch actions' }).click()
    await expect(page.getByRole('checkbox')).not.toBeChecked()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
