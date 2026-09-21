import { expect, test } from '@playwright/test'

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`attachment preview preserves its parent dialog with ${reducedMotion} motion`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ reducedMotion })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/modal-library-close.html?preview=1')
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    const title = page.getByRole('button', { name: 'Stable attachment preview', exact: true })
    await title.click()
    const detail = page.getByRole('dialog', { name: 'Stable attachment preview', exact: true })
    const trigger = detail.getByRole('button', { name: 'Preview paper.pdf', exact: true })
    await detail.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      const scrim = element.previousElementSibling!
      const samples: boolean[] = []
      let active = true
      const sample = (): void => {
        samples.push(
          element.isConnected &&
            scrim.isConnected &&
            getComputedStyle(element).opacity === '1' &&
            getComputedStyle(scrim).opacity === '1'
        )
        if (active) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      Object.assign(window, {
        previewAudit: {
          samples,
          stop: () => {
            active = false
          }
        }
      })
    })

    for (const close of ['button', 'Escape']) {
      await trigger.click()
      const preview = page.getByRole('dialog', { name: 'Preview paper.pdf', exact: true })
      await expect(preview.locator('[data-page-number="1"] canvas')).toBeVisible()
      const scroller = preview.getByRole('region', { name: 'paper.pdf scrollable preview' })
      await scroller.click()
      await page.keyboard.press('Tab')
      expect(await preview.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      )
      await scroller.hover()
      await page.mouse.wheel(0, 300)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      // The preview owns the top scroll lock: its PDF scrolls while the background stays locked.
      await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')
      if (close === 'button') {
        await page.screenshot({ path: testInfo.outputPath('attachment-preview.png') })
        await preview.getByRole('button', { name: 'Close preview of paper.pdf' }).click()
      } else {
        await scroller.focus()
        await page.keyboard.press('Escape')
      }
      await expect(preview).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')
    }
    const samples: boolean[] = await page.evaluate(() => {
      const audit = Reflect.get(window, 'previewAudit')
      audit.stop()
      return audit.samples
    })
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every(Boolean), 'parent panel and scrim stay opaque and mounted').toBe(true)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(title).toBeFocused()
    await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
    expect(errors).toEqual([])
  })
}

for (const entry of ['list', 'history', 'search'] as const) {
  test(`opens a scrollable PDF from ${entry} without remounting the parent`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const filename = entry === 'history' ? 'paper-v1.pdf' : 'paper.pdf'
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/modal-library-close.html?preview=${entry}`)
    if (entry !== 'search')
      await page.getByRole('button', { name: 'All references', exact: true }).click()
    if (entry === 'history') {
      await page.getByRole('button', { name: 'Stable attachment preview', exact: true }).click()
      await page.getByRole('button', { name: 'Attachment actions for paper.pdf' }).click()
      await page.getByRole('menuitem', { name: 'Version history' }).click()
    } else if (entry === 'search') {
      await page.getByRole('option').filter({ hasText: 'Stable attachment preview' }).click()
      await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    }
    const parent =
      entry === 'list'
        ? page.locator('main')
        : page.getByRole('dialog', {
            name: entry === 'search' ? 'Global search' : 'Stable attachment preview',
            exact: true,
            includeHidden: true
          })
    await parent.evaluate((element) => Object.assign(window, { previewParent: element }))
    if (entry === 'history')
      await page
        .getByRole('dialog', { name: 'Version history' })
        .getByRole('button', { name: `Preview ${filename}` })
        .click()
    else if (entry === 'search')
      await page.getByRole('button', { name: 'Open file', exact: true }).click()
    else await page.getByRole('button', { name: `Preview ${filename}` }).click()
    const preview = page.getByRole('dialog', { name: `Preview ${filename}`, exact: true })
    await expect(preview.locator('[data-page-number="1"] canvas')).toBeVisible()
    const scroller = preview.getByRole('region', { name: `${filename} scrollable preview` })
    await scroller.hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await preview.getByRole('button', { name: `Close preview of ${filename}` }).click()
    await expect(preview).toHaveCount(0)
    expect(
      await parent.evaluate((element) => element === Reflect.get(window, 'previewParent'))
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
