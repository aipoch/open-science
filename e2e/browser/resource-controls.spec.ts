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
    await row.getByRole('button', { name: `Manage access for ${name}` }).click()
    const popup = page.getByRole('dialog')
    await popup.getByRole('searchbox', { name: 'Search agents' }).fill('Researcher')
    await expect(popup.getByRole('switch')).toHaveCount(1)
    await expect(popup.getByRole('switch', { name: 'Researcher', exact: true })).toBeChecked()
    await popup.getByRole('switch', { name: 'Researcher', exact: true }).click()
    await expect(popup.getByRole('switch', { name: 'Researcher', exact: true })).not.toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Select multiple in Featured' }).click()
    await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check()
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
    await expect(row.getByLabel('Unavailable to Main Agent')).toBeVisible()
    await bar.getByRole('button', { name: 'Clear selection' }).click()
    await row.getByRole('button', { name: `View details for ${name}` }).click()
    await page.getByRole('button', { name: `Manage access for ${name}` }).click()
    await expect(page.getByRole('switch', { name: 'Main Agent', exact: true })).not.toBeChecked()
    expect(errors).toEqual([])
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
