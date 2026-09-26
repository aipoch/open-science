import { expect, test, type Locator } from '@playwright/test'

// Measure the rendered indicator against its composited surrounding surface, including bubbles.
const focusAppearance = (
  target: Locator
): Promise<{
  focused: boolean
  style: string
  width: number
  offset: number
  contrast: number
  opacity: number
}> =>
  target.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const ancestors: Element[] = []
    for (let node = element.parentElement; node; node = node.parentElement) ancestors.unshift(node)
    context.fillStyle = 'white'
    context.fillRect(0, 0, 1, 1)
    for (const node of ancestors) {
      context.fillStyle = getComputedStyle(node).backgroundColor
      context.fillRect(0, 0, 1, 1)
    }
    const luminance = (pixels: Uint8ClampedArray): number => {
      const linear = [...pixels].slice(0, 3).map((byte) => {
        const value = byte / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    const background = luminance(context.getImageData(0, 0, 1, 1).data)
    const style = getComputedStyle(element)
    context.fillStyle = style.outlineColor
    context.fillRect(0, 0, 1, 1)
    const indicator = luminance(context.getImageData(0, 0, 1, 1).data)
    return {
      focused: element === document.activeElement && element.matches(':focus-visible'),
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      offset: parseFloat(style.outlineOffset),
      contrast: (Math.max(background, indicator) + 0.05) / (Math.min(background, indicator) + 0.05),
      opacity: [element, ...ancestors].reduce(
        (opacity, node) => opacity * Number(getComputedStyle(node).opacity),
        1
      )
    }
  })

for (const dark of [false, true]) {
  test(`shows message focus and keeps the composer borderless in both directions (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/message-clipboard.html?keyboard${dark ? '&dark' : ''}`)
    const editor = page.getByRole('textbox', { name: 'Ask anything' })
    const after = page.getByRole('button', { name: 'After composer', exact: true })
    const reference = page.getByRole('link', { name: 'Reference link' })
    const file = page.getByRole('button', { name: 'Preview volcano-plot.csv', exact: true })
    const secondFile = page.getByRole('button', {
      name: 'Preview volcano-plot-differential-analysis.xlsx',
      exact: true
    })
    const copy = page.getByRole('button', { name: 'Copy message', exact: true })
    const sent = page.locator('time')
    await editor.click()
    expect((await focusAppearance(editor)).style).toBe('none')
    await after.click()
    await page.mouse.move(0, 0)
    await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    expect((await focusAppearance(editor)).style).toBe('none')
    // Disabled actions must be skipped, and focus itself must not submit or activate anything.
    for (const target of [sent, secondFile, file, copy]) {
      await page.keyboard.press('Shift+Tab')
      const appearance = await focusAppearance(target)
      expect(appearance.focused).toBe(true)
      expect.soft(appearance.style).toBe('solid')
      expect.soft(appearance.width).toBeGreaterThanOrEqual(2)
      expect.soft(appearance.offset).toBeGreaterThanOrEqual(2)
      expect.soft(appearance.contrast).toBeGreaterThanOrEqual(3)
      expect.soft(appearance.opacity).toBe(1)
    }
    await expect(page.getByRole('tooltip')).toHaveText('Copy message')
    await page.screenshot({ path: testInfo.outputPath('message-focus.png') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(copy).toBeFocused()
    for (const target of [file, secondFile, sent, editor, after, reference]) {
      await page.keyboard.press('Tab')
      expect((await focusAppearance(target)).focused).toBe(true)
    }
    expect((await focusAppearance(reference)).contrast).toBeGreaterThanOrEqual(3)
    await expect(editor).toHaveText('')
    await expect(page.getByTestId('preview')).toHaveCount(0)
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    expect((await focusAppearance(editor)).style).toBe('none')
    await page.screenshot({ path: testInfo.outputPath('composer-focus.png') })
  })

  test(`keeps shared button focus visible for keyboard and forced colors (${dark ? 'dark' : 'light'})`, async ({
    page
  }) => {
    await page.goto(`/button-feedback.html${dark ? '?dark' : ''}`)
    const finish = page.getByRole('button', { name: 'Finish save', exact: true })
    const reject = page.getByRole('button', { name: 'Reject next copy', exact: true })
    await finish.click()
    expect((await focusAppearance(finish)).focused).toBe(false)
    const box = await finish.boundingBox()
    await page.keyboard.press('Tab')
    await expect(reject).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    const appearance = await focusAppearance(finish)
    expect.soft(appearance.style).toBe('solid')
    expect.soft(appearance.width).toBeGreaterThanOrEqual(2)
    expect.soft(appearance.offset).toBeGreaterThanOrEqual(2)
    expect.soft(appearance.contrast).toBeGreaterThanOrEqual(3)
    expect(await finish.boundingBox()).toEqual(box)
    const animations = await finish.evaluate((element) =>
      element.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty)
    )
    expect(animations).not.toContain('box-shadow')
    expect(animations).not.toContain('outline-color')
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    const forced = await focusAppearance(finish)
    expect(forced.focused).toBe(true)
    expect(forced.style).toBe('solid')
    expect(forced.width).toBeGreaterThanOrEqual(2)
  })
}

for (const dark of [false, true]) {
  test(`keeps the Reading row outline inside its clipped group (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/message-clipboard.html?keyboard${dark ? '&dark' : ''}`)
    await page.getByRole('link', { name: 'Reference link' }).focus()
    await page.keyboard.press('Tab')
    const row = page.getByTestId('tool-chip')
    const appearance = await focusAppearance(row)
    expect(appearance.focused).toBe(true)
    expect(appearance.style).toBe('solid')
    expect(appearance.offset).toBeLessThanOrEqual(-appearance.width)
    expect(appearance.contrast).toBeGreaterThanOrEqual(3)
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: testInfo.outputPath('reading-row-focus.png') })
    await page.keyboard.press('Enter')
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('reading-details')).toBeVisible()
  })
}

for (const dark of [false, true]) {
  test(`keeps preview tab, close and Python focus bounded (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/preview-keyboard.html${dark ? '?dark' : ''}`)
    const tab = page.getByRole('tab', { name: 'Notebook', exact: true })
    const close = page.getByRole('button', { name: 'Close preview of Notebook', exact: true })
    const agent = page.getByRole('combobox', { name: 'Filter notebook runs by Agent' })
    const python = page.getByTestId('kernel-switcher-python')
    await expect(python).toBeVisible()
    await page.getByRole('button', { name: 'Before preview' }).click()
    await page.keyboard.press('Tab')
    for (const target of [tab, close]) {
      await expect(target).toBeFocused()
      const appearance = await focusAppearance(target)
      expect(appearance.style).toBe('solid')
      expect(appearance.width).toBe(2)
      expect(appearance.offset).toBeLessThanOrEqual(-appearance.width)
      await page.keyboard.press('Tab')
    }
    // The content wrapper must not add a Tab stop that paints only a horizontal line.
    await expect(agent).toBeFocused()
    await expect(page.getByRole('tabpanel')).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('Tab')
    await expect(python).toBeFocused()
    const appearance = await focusAppearance(python)
    expect(appearance.style).toBe('solid')
    expect(appearance.width).toBe(2)
    expect(appearance.offset).toBeLessThanOrEqual(-appearance.width)
    expect(appearance.contrast).toBeGreaterThanOrEqual(3)
    await page.locator('main').screenshot({ path: testInfo.outputPath('preview-python-focus.png') })
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(close).toBeFocused()
    await page.locator('main').screenshot({ path: testInfo.outputPath('preview-close-focus.png') })
    await page.keyboard.press('Enter')
    await expect(tab).toHaveCount(0)
  })
}

for (const dark of [false, true]) {
  test(`keeps environment chips inside the Notebook scroller (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/preview-keyboard.html?environments${dark ? '&dark' : ''}`)
    const python = page.getByTestId('kernel-switcher-python')
    await expect(python).toBeVisible()
    await python.click()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Inspect variables', exact: true })).toBeFocused()
    const environments = page.getByTestId('env-selector').getByRole('button')
    for (const target of await environments.all()) {
      await page.keyboard.press('Tab')
      await expect(target).toBeFocused()
      const appearance = await focusAppearance(target)
      expect(appearance.style).toBe('solid')
      expect(appearance.width).toBe(2)
      expect(appearance.offset).toBeLessThanOrEqual(-appearance.width)
      await expect(page.getByTestId('env-selector')).toHaveCSS('mask-image', 'none')
      await expect
        .poll(async () => {
          const bounds = (await target.boundingBox())!
          const scroller = (await page.getByTestId('env-selector').boundingBox())!
          return Math.max(
            scroller.x - bounds.x,
            bounds.x + bounds.width - scroller.x - scroller.width
          )
        })
        .toBeLessThanOrEqual(1)
    }
    await page.locator('main').screenshot({ path: testInfo.outputPath('environment-focus.png') })
  })

  test(`skips Notebook history wrappers and keeps kernel navigation (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/preview-keyboard.html?history${dark ? '&dark' : ''}`)
    const python = page.getByRole('tab', { name: 'Python 1', exact: true })
    const r = page.getByRole('tab', { name: 'R 1', exact: true })
    await python.click()
    await page.keyboard.press('ArrowRight')
    await expect(r).toBeFocused()
    const appearance = await focusAppearance(r)
    expect(appearance.style).toBe('solid')
    expect(appearance.width).toBe(2)
    expect(appearance.offset).toBeLessThanOrEqual(-appearance.width)
    expect(appearance.contrast).toBeGreaterThanOrEqual(3)
    await expect(page.getByRole('tabpanel')).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('Tab')
    const copy = page.getByRole('button', { name: 'Copy to clipboard', exact: true })
    await expect(copy).toBeFocused()
    expect((await focusAppearance(copy)).opacity).toBe(1)
    expect((await focusAppearance(copy)).contrast).toBeGreaterThanOrEqual(3)
    await page.keyboard.press('Shift+Tab')
    await expect(r).toBeFocused()
    await page.locator('main').screenshot({ path: testInfo.outputPath('history-kernel-focus.png') })
  })
}

test('skips Settings content wrappers without changing tab activation', async ({ page }) => {
  await page.goto('/tab-motion.html')
  const models = page.locator('[data-models]')
  await models.getByRole('tab', { name: 'Local parsing models', exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(
    models.getByRole('link', { name: 'microsoft/table-transformer', exact: true })
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(models.getByRole('button', { name: 'Install', exact: true })).toBeFocused()
  await expect(models.getByRole('tabpanel')).toHaveAttribute('tabindex', '-1')
  const capabilities = page.locator('[data-capabilities]')
  await expect(capabilities.getByRole('tabpanel')).toHaveAttribute('tabindex', '-1')
})
