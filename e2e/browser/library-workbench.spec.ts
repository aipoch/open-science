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

for (const { width, query, reasonLabel, closeLabel } of [
  { width: 320, query: '', reasonLabel: 'Attachment unavailable', closeLabel: 'Close' },
  { width: 375, query: '&zh&dark', reasonLabel: '附件不可用', closeLabel: '关闭' }
]) {
  test(`unavailable PDF reasons remain visible and keyboard accessible at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(`/library-workbench.html?unavailable-pdf${query}`)
    const pdf = page.getByRole('button', { name: 'missing-reference.pdf', exact: true })
    const reason = page.getByRole('button', { name: reasonLabel, exact: true })
    await expect(pdf).toBeDisabled()
    await expect(reason).toBeVisible()
    await expect(pdf).toHaveAccessibleDescription(reasonLabel)
    await reason.focus()
    await reason.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: closeLabel, exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(reason).toBeFocused()
    await page.getByRole('button', { name: /Example reference/ }).click()
    const extraPdf = page.getByRole('button', {
      name: 'additional-missing-reference.pdf',
      exact: true
    })
    await expect(extraPdf).toBeDisabled()
    await expect(extraPdf).toHaveAccessibleDescription(reasonLabel)
    await expect(page.getByRole('button', { name: reasonLabel, exact: true })).toHaveCount(2)
    await expect(
      page.getByRole('button', { name: 'available-reference.pdf', exact: true })
    ).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

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
    const selectAll = page.getByRole('checkbox', { name: 'Select all references' })
    await selectAll.check()
    await expect(page.getByText('Selected: 1', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add to chat', exact: true }).first().click()
    await expect(page.getByRole('status').filter({ hasText: 'session-0:' })).toBeVisible()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Batch actions' }).click()
    await expect(selectAll).not.toBeChecked()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const width of [320, 375, 414, 768]) {
  for (const dark of [false, true]) {
    test(`Inbox Preview fits ${width}px in ${dark ? 'dark' : 'light'} mode`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 850 })
      await page.goto(`/library-workbench.html?inbox&zh${dark ? '&dark' : ''}`)
      await expect(page.getByRole('list', { name: '收件箱' })).toBeVisible()
      await expect(page.getByRole('button', { name: '收件箱', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      await page
        .getByRole('button', { name: 'Dose and timing effects of caffeine on subsequent sleep' })
        .focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('link', { name: 'PMID: 39377163' })).toBeVisible()
      await page.getByRole('button', { name: '批量操作', exact: true }).click()
      await page.getByRole('list', { name: '收件箱' }).getByRole('checkbox').first().check()
      await expect(page.getByText('已选：1', { exact: true })).toBeVisible()
      const selectAll = page.getByRole('checkbox', { name: '选择所有文献' })
      await expect(selectAll).toBeChecked({ indeterminate: true })
      await selectAll.check()
      await expect(page.getByText('已选：4', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      await page.screenshot({
        path: testInfo.outputPath(`inbox-${width}-${dark ? 'dark' : 'light'}.png`)
      })
    })
  }
}

test('save card opens Inbox in the same Preview and review actions update the queue', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/library-workbench.html?inbox&card')
  await page.getByRole('button', { name: 'Open Inbox', exact: true }).click()
  const inbox = page.getByRole('list', { name: 'Inbox', exact: true })
  await expect(inbox.getByRole('listitem')).toHaveCount(4)
  await page.getByRole('button', { name: 'Open Inbox', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Library preview' })).toHaveCount(1)
  await inbox.getByRole('button', { name: 'Dismiss', exact: true }).first().click()
  await expect(inbox.getByRole('listitem')).toHaveCount(3)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(inbox.getByRole('listitem')).toHaveCount(4)
  await inbox.getByRole('button', { name: 'Accept', exact: true }).first().click()
  await expect(inbox.getByRole('listitem')).toHaveCount(3)
  await page.getByRole('searchbox').fill('missing')
  await expect(page.getByText('No matching references', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open Inbox', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(inbox.getByRole('listitem')).toHaveCount(3)
})

test('Inbox batch icon reveals checkboxes and accepts only selected candidates', async ({
  page
}) => {
  await page.goto('/library-workbench.html?inbox')
  const inbox = page.getByRole('list', { name: 'Inbox', exact: true })
  await expect(inbox.getByRole('listitem')).toHaveCount(4)
  await expect(page.getByText(/Accepting will link to/)).toHaveCount(0)
  await expect(inbox.getByRole('checkbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Batch actions', exact: true }).click()
  await inbox.getByRole('checkbox').nth(0).check()
  await inbox.getByRole('checkbox').nth(2).check()
  await expect(page.getByText('Selected: 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(inbox.getByRole('listitem')).toHaveCount(2)
  await expect(
    inbox.getByRole('button', {
      name: 'Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed'
    })
  ).toBeVisible()
  await expect(page.getByText('Selected: 0', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(inbox.getByRole('checkbox')).toHaveCount(0)
})

for (const width of [320, 375, 414, 768]) {
  for (const dark of [false, true]) {
    test(`Message tool cards stay compact at ${width}px in ${dark ? 'dark' : 'light'} mode`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1100 })
      await page.goto(
        `/library-workbench.html?density&${dark ? 'dark&' : ''}${width === 375 ? 'zh' : ''}`
      )
      const cards = page.getByTestId('literature-tool-card')
      await expect(cards).toHaveCount(6)
      const stack = page.getByTestId('reading-stack')
      const bounds = await stack.boundingBox()
      // Three minimal reading cards should leave room for the answer, including on narrow panels.
      expect(bounds!.height).toBeLessThan(270)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      expect(
        await cards.evaluateAll((elements) =>
          elements.every((element) => element.scrollWidth <= element.clientWidth)
        )
      ).toBe(true)
      await expect(cards.nth(3).getByText(/long-reference-name/)).toBeVisible()
      await expect(cards.nth(3).getByText(/Evidence requires/)).toBeVisible()
      const openInbox = cards.nth(4).getByRole('button')
      await openInbox.focus()
      await expect(openInbox).toBeFocused()
      const path = page.getByTestId('tool-summary-card').locator('summary')
      await path.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByText('/example/runtime/python', { exact: true })).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`message-cards-${width}-${dark ? 'dark' : 'light'}.png`),
        fullPage: true
      })
    })
  }
}
