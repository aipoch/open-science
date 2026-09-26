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
  test(`shows immediate focus through messages and composer in both directions (${dark ? 'dark' : 'light'})`, async ({
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
    await after.click()
    await page.mouse.move(0, 0)
    // Disabled actions must be skipped, and focus itself must not submit or activate anything.
    for (const target of [editor, sent, secondFile, file, copy]) {
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
