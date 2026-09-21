import { expect, test } from '@playwright/test'

for (const kind of ['skills', 'connectors']) {
  const suffix = kind === 'connectors' ? '?connectors' : ''
  test(`${kind}: independent access, conditional bulk warnings and Specialist search`, async ({
    page
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/resource-controls.html${suffix}`)
    const row = page.locator('[data-slot="settings-list-row"]').first()
    const name = kind === 'skills' ? 'AlphaFold2' : 'Chemistry'
    const trigger = row.getByRole('button', { name: `Manage access for ${name}` })
    await trigger.hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'Control access separately for Main Agent and each Specialist.'
    )
    await trigger.click()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    const popup = page.getByRole('dialog')
    await expect(popup.getByText(name, { exact: true })).toHaveCount(0)
    await expect(popup.getByText('Allow Main Agent to load this resource.')).toBeVisible()
    await expect(popup.getByText('Specialist associations', { exact: true })).toBeVisible()
    await popup.getByRole('searchbox', { name: 'Search Specialists' }).fill('Researcher')
    await expect(popup.getByRole('switch')).toHaveCount(2)
    await expect(popup.getByRole('switch', { name: 'Researcher', exact: true })).toBeChecked()
    await popup.getByRole('switch', { name: 'Researcher', exact: true }).click()
    await expect(popup.getByRole('switch', { name: 'Researcher', exact: true })).not.toBeChecked()
    await page.locator('header').click()
    await expect(popup).toHaveCount(0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await page.getByRole('button', { name: 'Select multiple in Featured' }).click()
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check()
    const checkbox = row.getByRole('checkbox')
    const content = row.locator('[data-slot="resource-row-content"]')
    const checkboxBounds = (await checkbox.boundingBox())!
    const contentBounds = (await content.boundingBox())!
    expect(checkboxBounds.x + checkboxBounds.width).toBeLessThan(contentBounds.x)
    await checkbox.hover()
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(content).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await content.hover()
    await expect(content).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const bar = page.getByRole('region', { name: 'Selected resources' })
    await expect(bar.getByRole('button', { name: /Unlink Specialists/ })).toHaveCount(0)
    await expect(bar.getByRole('button', { name: 'Delete selected' })).toHaveCount(0)
    const stop = bar.getByRole('button', { name: /Stop Main Agent loading/ })
    await stop.hover()
    await expect(page.getByRole('tooltip')).toContainText('Future Main Agent tasks')
    await stop.click()
    await expect(stop).toHaveCount(0)
    await bar.getByRole('button', { name: 'Add to Specialist' }).click()
    await page.getByRole('searchbox', { name: 'Search Specialists' }).fill('Researcher')
    await page.getByRole('button', { name: 'Researcher', exact: true }).click()
    const unlink = bar.getByRole('button', { name: /Unlink Specialists/ })
    await expect(unlink).toBeVisible()
    await unlink.focus()
    await expect(page.getByRole('tooltip')).toContainText('Future Specialist tasks')
    await unlink.click()
    await expect(unlink).toHaveCount(0)
    await bar.getByRole('button', { name: 'Clear selection' }).click()
    await row.getByRole('button', { name: `View details for ${name}` }).click()
    await page.getByRole('button', { name: `Manage access for ${name}` }).click()
    await expect(page.getByRole('switch', { name: 'Main Agent', exact: true })).not.toBeChecked()
    expect(errors).toEqual([])
  })

  test(`${kind}: disabled controls do not forward clicks to the row`, async ({ page }) => {
    await page.goto(`/resource-controls.html${suffix}`)
    await page.evaluate((kind) => {
      const command = kind === 'skills' ? 'setSkillEnabled' : 'setConnectorEnabled'
      // Hold the fixture write pending so the test can hit the genuinely disabled control.
      window.api.settings[command] = async () => new Promise<never>(() => {})
    }, kind)
    await page.getByRole('button', { name: 'Select multiple in Featured' }).click()
    const row = page.locator('[data-slot="settings-list-row"]').first()
    await row.getByRole('checkbox').check()
    await page.getByRole('button', { name: /Stop Main Agent loading/ }).click()
    const trigger = row.locator('[data-slot="resource-assignment-trigger"]')
    await expect(trigger).toBeDisabled()
    await trigger.click({ force: true })
    await expect(row).toBeVisible()
    await expect(page.getByRole('region', { name: 'Selected resources' })).toBeVisible()
  })

  test(`${kind}: row padding opens details while embedded controls stay independent`, async ({
    page
  }) => {
    await page.goto(`/resource-controls.html${suffix}`)
    const row = page.locator('[data-slot="settings-list-row"]').first()
    const usage = row.locator('[data-slot="skill-usage-agents-trigger"]')
    await usage.click()
    await expect(page.locator('[data-slot="skill-usage-agents-popover"]')).toBeVisible()
    await expect(row).toBeVisible()
    await page.locator('header').click()
    await row.getByRole('button', { name: 'Manage Tags', exact: true }).click()
    await expect(row).toBeVisible()
    await page.keyboard.press('Escape')
    // Exercise the hover surface outside every nested button, including the row's padding.
    await row.click({ position: { x: 4, y: 4 } })
    await expect(page.getByRole('region', { name: 'Availability', exact: true })).toBeVisible()
  })

  test(`${kind}: filter and current category remain sticky and selection survives filtering`, async ({
    page
  }) => {
    await page.goto(`/resource-controls.html${suffix}`)
    await page.getByRole('button', { name: 'Select multiple in Featured' }).click()
    await page.locator('[data-slot="settings-list-row"] input[type="checkbox"]').first().check()
    const search = page.getByRole('searchbox', {
      name: kind === 'skills' ? 'Search skills' : 'Search connectors',
      exact: true
    })
    await search.fill('not-in-catalog')
    await expect(
      page.getByRole('button', { name: /Select multiple in|Finish selection in/ })
    ).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Selected resources' })).toContainText(
      '1 hidden by filters'
    )
    await search.fill('')
    const scroller = page.getByTestId('catalog-scroll')
    await scroller.evaluate((element) => {
      element.scrollTop = 380
    })
    const filter = page.locator(`[data-slot="${kind}-filter-bar"]`)
    const section = page
      .locator(`[data-slot="${kind}-source-group"]`)
      .first()
      .locator(':scope > div')
      .first()
    await expect.poll(async () => (await filter.boundingBox())!.y).toBeLessThanOrEqual(62)
    const filterBottom = await filter.evaluate(
      (element) => element.closest('.sticky')!.getBoundingClientRect().bottom
    )
    expect((await section.boundingBox())!.y).toBeCloseTo(filterBottom, 0)
    const filterContainer = kind === 'skills' ? filter.locator('xpath=..') : filter
    const surfaceColor = await page
      .locator('main')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    await expect(filterContainer).toHaveCSS('background-color', surfaceColor)
    await expect(section).toHaveCSS('background-color', surfaceColor)
    const headerBounds = (await section.boundingBox())!
    const filterBounds = (await filterContainer.boundingBox())!
    expect(headerBounds.x).toBeCloseTo(filterBounds.x, 0)
    expect(headerBounds.width).toBeCloseTo(filterBounds.width, 0)
    await expect(page.getByRole('region', { name: 'Selected resources' })).toBeInViewport()
  })
}

for (const width of [375, 880]) {
  for (const dark of [false, true]) {
    test(`localized resource controls fit ${width}px ${dark ? 'dark' : 'light'}`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 760 })
      await page.goto(`/resource-controls.html?locale=zh-Hans${dark ? '&dark' : ''}`)
      await page.getByRole('button', { name: '在“精选”中多选' }).click()
      await page.getByRole('checkbox', { name: '选择 AlphaFold2', exact: true }).check()
      await expect(page.getByRole('region', { name: '选中的资源' })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      await page.getByRole('button', { name: '管理“AlphaFold2”的访问权限' }).click()
      const popup = page.getByRole('dialog')
      await expect(popup.getByRole('switch', { name: '主智能体' })).toBeVisible()
      const bounds = (await popup.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(760)
      await page.screenshot({
        path: testInfo.outputPath(`resource-controls-${width}-${dark ? 'dark' : 'light'}.png`)
      })
    })
  }
}

for (const kind of ['skills', 'connectors']) {
  test(`${kind}: rejected filtered switch reports failure`, async ({ page }) => {
    await page.goto(`/resource-controls.html${kind === 'connectors' ? '?connectors' : ''}`)
    await page.evaluate((kind) => {
      const command = kind === 'skills' ? 'setSkillEnabled' : 'setConnectorEnabled'
      window.api.settings[command] = async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        throw new Error('review simulated save failure')
      }
    }, kind)
    await page
      .getByRole('combobox', {
        name: kind === 'skills' ? 'Filter Skills by agent' : 'Filter Connectors by agent'
      })
      .click()
    await page.getByRole('option', { name: 'Main Agent', exact: true }).click()
    const name = kind === 'skills' ? 'AlphaFold2' : 'Chemistry'
    const trigger = page.getByRole('button', { name: `Manage access for ${name}` })
    await trigger.click()
    await page.getByRole('switch', { name: 'Main Agent', exact: true }).click()
    await expect(trigger).toHaveCount(0)
    await expect(trigger).toBeVisible()
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 1500 })
  })
}
test('delete review accepts keyboard focus', async ({ page }) => {
  await page.goto('/resource-controls.html')
  await page.getByRole('button', { name: 'Select multiple in Personal' }).click()
  await page.getByRole('checkbox', { name: 'Select Personal workflow 2', exact: true }).check()
  const trigger = page.getByRole('button', { name: 'Delete selected' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Confirm deletion 1', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[data-slot="batch-manage-review"]')
    )
  ).toBe(true)
})

for (const count of [5, 6, 18]) {
  test(`resource menus show search only above five Specialists: ${count}`, async ({ page }) => {
    await page.goto(`/resource-controls.html?specialists=${count}`)
    await page.getByRole('button', { name: 'Manage access for AlphaFold2' }).click()
    const popup = page.getByRole('dialog')
    await expect(popup.getByRole('searchbox')).toHaveCount(count > 5 ? 1 : 0)
    await expect(popup.getByRole('switch')).toHaveCount(count + 1)
    if (count > 5) {
      await popup.getByRole('searchbox', { name: 'Search Specialists' }).fill('no-result')
      await expect(popup.getByRole('searchbox')).toBeVisible()
      await expect(popup.getByRole('switch', { name: 'Main Agent' })).toBeVisible()
      await expect(popup.getByText('No Specialists match your search.')).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Select multiple in Featured' }).click()
    await page.getByRole('checkbox', { name: 'Select AlphaFold2', exact: true }).check()
    await page.getByRole('button', { name: 'Add to Specialist', exact: true }).click()
    await expect(popup.getByRole('searchbox')).toHaveCount(count > 5 ? 1 : 0)
    if (count === 18) {
      const last = popup.getByRole('button', { name: 'Research team 18', exact: true })
      const list = last.locator('..')
      expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true
      )
      await last.scrollIntoViewIfNeeded()
      await expect(last).toBeInViewport()
    }
    if (count > 5) {
      await popup.getByRole('searchbox').fill('Researcher')
      await expect(popup.getByRole('button', { name: /^Research/ })).toHaveCount(1)
      await expect(popup.getByRole('searchbox')).toBeVisible()
    }
  })
}

test('recovers Specialist actions after a failed catalog read', async ({ page }) => {
  await page.goto('/resource-controls.html?specialists=1&catalog-load-error')
  await page.getByRole('button', { name: 'Manage access for AlphaFold2' }).click()
  const control = page.getByRole('switch', { name: 'Researcher', exact: true })
  await expect(control).toBeDisabled()
  await page.getByRole('dialog').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(control).toBeEnabled()
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', 'false')
})

test('a transient assignment read failure can be retried without reopening Settings', async ({
  page
}) => {
  await page.goto('/resource-controls.html?specialists=1')
  await page.getByRole('button', { name: 'Manage access for AlphaFold2' }).click()
  await page.evaluate(() => {
    const read = window.api.specialist.list
    window.api.specialist.list = async () => {
      window.api.specialist.list = read
      throw new Error('temporary read failure')
    }
  })
  const control = page.getByRole('switch', { name: 'Researcher', exact: true })
  await control.click()
  await expect(page.getByRole('alert').first()).toBeVisible()
  await expect(control).toBeEnabled()
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', 'false')
})
