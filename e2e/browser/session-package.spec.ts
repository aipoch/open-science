import { expect, test } from '@playwright/test'

test('full and compact presets simplify selection while retaining evidence', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/session-package.html')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('radio', { name: 'Full export', exact: true })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('presets-full.png') })
  await dialog.getByRole('radio', { name: 'Compact export', exact: true }).check()
  await expect(dialog.getByText('Selected: 0 / 29 files · 0 B')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('presets-compact.png') })
  await dialog.getByRole('button', { name: 'Customize contents', exact: true }).click()
  const required = dialog.getByRole('checkbox', { name: 'research-result-0.csv', exact: true })
  await dialog.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(required).toBeDisabled()
  await expect(required).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('presets-custom.png') })
  await dialog.getByRole('radio', { name: 'Full export', exact: true }).check()
  await expect(dialog.getByText('Selected: 29 / 29 files · 464.0 KiB')).toBeVisible()
  await expect(dialog.getByLabel('Search optional files', { exact: true })).toHaveCount(0)
})

for (const width of [1280, 414]) {
  for (const empty of [true, false]) {
    test(`export customization stays stable at ${width}px with ${empty ? 'no' : 'many'} files`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(`/session-package.html${empty ? '?empty' : ''}`)
      const dialog = page.getByRole('dialog', { name: 'Export Session package', exact: true })
      const customize = dialog.getByRole('button', { name: 'Customize contents', exact: true })
      const save = dialog.getByRole('button', { name: 'Choose save location', exact: true })
      await expect(customize).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const before = await dialog.boundingBox()
      const footer = await save.boundingBox()
      await page.screenshot({ path: testInfo.outputPath('export-collapsed.png') })
      await customize.click()
      const search = dialog.getByLabel('Search optional files', { exact: true })
      await expect(search).toBeVisible()
      const after = await dialog.boundingBox()
      for (const key of ['x', 'y', 'width', 'height'] as const)
        expect.soft(Math.abs(after![key] - before![key]), `dialog ${key}`).toBeLessThanOrEqual(1)
      expect
        .soft(Math.abs((await save.boundingBox())!.y - footer!.y), 'footer position')
        .toBeLessThanOrEqual(1)
      const filters = dialog.locator('summary').filter({ hasText: /^File filters$/ })
      await search.scrollIntoViewIfNeeded()
      const inputBox = await search.boundingBox()
      const filterBox = await filters.boundingBox()
      expect
        .soft(filterBox!.y - inputBox!.y - inputBox!.height, 'search/filter gap')
        .toBeGreaterThanOrEqual(12)
      await filters.click()
      await expect(dialog.getByLabel('Large-file threshold (MiB)')).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('export-expanded.png') })
      const afterFilters = await dialog.boundingBox()
      expect.soft(afterFilters!.height).toBeCloseTo(before!.height, 0)
      expect.soft(Math.abs((await save.boundingBox())!.y - footer!.y)).toBeLessThanOrEqual(1)
      expect.soft(afterFilters!.x).toBeGreaterThanOrEqual(0)
      expect.soft(afterFilters!.x + afterFilters!.width).toBeLessThanOrEqual(width)
      await customize.click()
      await expect(search).toHaveCount(0)
      expect((await dialog.boundingBox())!.height).toBeCloseTo(before!.height, 0)
    })
  }
}

for (const width of [1280, 414]) {
  test(`opened package chooses a project and confirms in one dialog at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/session-package.html?import=project')
    const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    if (width === 1280) {
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished)
        )
      })
      const cancel = await dialog
        .getByRole('button', { name: 'Cancel operation', exact: true })
        .boundingBox()
      const primary = await dialog
        .getByRole('button', { name: 'Continue', exact: true })
        .boundingBox()
      expect
        .soft(primary!.x - cancel!.x - cancel!.width, 'cancel beside primary action')
        .toBeLessThanOrEqual(12)
    }
    await page.screenshot({ path: testInfo.outputPath('import-project.png') })
    await dialog.getByRole('radio', { name: 'Cancer immunotherapy' }).check()
    await dialog.getByRole('radio', { name: 'Cancer immunotherapy' }).press('ArrowDown')
    await expect(dialog.getByRole('radio', { name: 'Biomaterials research' })).toBeChecked()
    await dialog.getByRole('radio', { name: 'Cancer immunotherapy' }).check()
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(
      dialog.getByText('Nanomaterials and tumour immunity', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    const omissions = dialog.locator('details').filter({ hasText: /^Not included/ })
    await expect(omissions).not.toHaveAttribute('open')
    await page.screenshot({ path: testInfo.outputPath('import-review.png') })
    await dialog.getByRole('button', { name: 'Import Session package', exact: true }).click()
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', String(18 * 1024 ** 2))
    await page.screenshot({ path: testInfo.outputPath('import-progress.png') })
    const box = await dialog.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  })
}

for (const width of [1280, 768, 414, 375, 320]) {
  test(`creates an import destination without an accordion or stacked dialog at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/session-package.html?import=project')
    const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
    await dialog.getByRole('button', { name: 'New project', exact: true }).click()
    const name = dialog.getByRole('textbox', { name: 'Project name' })
    await expect(name).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    const box = await dialog.boundingBox()
    await page.screenshot({ path: testInfo.outputPath('new-project-form.png') })
    await name.fill('Imported research')
    await name.press('Enter')
    await expect(dialog.getByText('Imported research', { exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Import Session package', exact: true })
    ).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('new-project-selected.png') })
    const after = await dialog.boundingBox()
    expect(after?.height).toBe(box?.height)
    expect(after!.x).toBeGreaterThanOrEqual(0)
    expect(after!.x + after!.width).toBeLessThanOrEqual(width)
  })
}

for (const width of [1280, 320]) {
  test(`waiting queue opens from the header without disturbing import at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/session-package.html?import=project')
    const dialog = page.getByRole('dialog', { name: 'Import Session package', exact: true })
    const trigger = dialog.getByRole('button', { name: 'Waiting packages (1)', exact: true })
    await expect(page.getByText('follow-up-study.science', { exact: true })).toHaveCount(0)
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished)
      )
    })
    const queueButton = await trigger.boundingBox()
    const closeButton = await dialog
      .getByRole('button', { name: 'Hide progress', exact: true })
      .boundingBox()
    const primaryButton = await dialog
      .getByRole('button', { name: 'Continue', exact: true })
      .boundingBox()
    expect.soft(queueButton!.height, 'header control height').toBe(closeButton!.height)
    expect
      .soft(
        Math.abs(
          queueButton!.y + queueButton!.height / 2 - closeButton!.y - closeButton!.height / 2
        ),
        'header control alignment'
      )
      .toBeLessThanOrEqual(1)
    expect
      .soft(
        Math.abs(closeButton!.x + closeButton!.width - primaryButton!.x - primaryButton!.width),
        'header/footer right edge'
      )
      .toBeLessThanOrEqual(1)
    await trigger.click()
    const queue = page.getByRole('dialog', { name: 'Waiting packages', exact: true })
    await expect(queue.getByText('follow-up-study.science', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('waiting-queue.png') })
    const box = await queue.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await queue.press('Escape')
    await expect(queue).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await queue.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(trigger).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: 'Cancer immunotherapy' }).check()
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled()
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`shared package recovery notices remain readable at 320px in ${theme}`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/session-package.html?import=error')
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value),
      theme === 'dark'
    )
    const dialog = page.getByRole('dialog')
    const alert = dialog.getByRole('alert')
    await expect(alert).toContainText('The package could not be imported.')
    await expect(alert).not.toContainText('Last stage:')
    await expect(dialog.getByRole('heading', { name: 'Package operation failed' })).toHaveCount(0)
    const notice = alert.locator('xpath=ancestor::section')
    await expect(notice).toHaveCSS('border-top-width', '0px')
    const summary = dialog.locator('summary').filter({ hasText: /^Details$/ })
    const noticeBounds = await notice.boundingBox()
    const summaryBounds = await summary.boundingBox()
    expect(Math.abs(noticeBounds!.y - summaryBounds!.y)).toBeLessThan(8)
    await dialog.screenshot({ path: testInfo.outputPath(`package-inline-error-${theme}.png`) })
    await page.setViewportSize({ width: 320, height: 820 })
    await dialog
      .locator('summary')
      .filter({ hasText: /^Details$/ })
      .click()
    await expect(dialog.getByText('Last stage: Importing research…')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Try again', exact: true })).toBeInViewport()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    )
    await page.screenshot({ path: testInfo.outputPath(`package-error-${theme}.png`) })
    await page.goto('/session-package.html?import=progress&queue-full')
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value),
      theme === 'dark'
    )
    await expect(dialog.getByRole('alert')).toContainText('Waiting list is full.')
    const queueNotice = dialog.getByRole('alert').locator('xpath=ancestor::section')
    await expect(queueNotice).toHaveCSS('border-top-width', '0px')
    const iconBounds = await queueNotice.locator('svg').boundingBox()
    const textBounds = await dialog.getByRole('alert').boundingBox()
    expect(Math.abs(iconBounds!.y - textBounds!.y)).toBeLessThan(8)
    await expect(dialog.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport()
    await expect(
      dialog.getByRole('button', { name: 'Cancel operation', exact: true })
    ).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`package-queue-${theme}.png`) })
  })
}

test('opens package export directly from the shared Session export submenu', async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto('/session-package.html?menu')
  const trigger = page.getByRole('button', { name: 'Session menu', exact: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Export', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(
    page.getByRole('menuitem', { name: 'Export conversation…', exact: true })
  ).toBeVisible()
  const item = page.getByRole('menuitem', { name: 'Export Session package', exact: true })
  await expect(item).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('session-export-menu.png') })
  await item.click()
  await expect(
    page.getByRole('dialog', { name: 'Export Session package', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
})
