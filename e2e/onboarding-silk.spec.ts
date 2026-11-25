import { expect } from '@playwright/test'
import type { Locator } from 'playwright'
import sharp from 'sharp'
import { test } from './fixtures/electron-app'

test.use({ windowMode: 'normal' })

const pixels = (canvas: Locator): Promise<string> =>
  canvas.evaluate((element: HTMLCanvasElement) => {
    const sample = document.createElement('canvas')
    sample.width = sample.height = 32
    const ctx = sample.getContext('2d')!
    ctx.drawImage(element, 0, 0, 32, 32)
    const rgba = ctx.getImageData(0, 0, 32, 32).data
    const shades = new Set<number>()
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3]) shades.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2])
    }
    if (shades.size < 3) throw new Error('Silk has not painted a textured frame')
    return sample.toDataURL()
  })

const waitForCardTransitions = (card: Locator): Promise<void> =>
  card.evaluate(async (element) => {
    const transitions = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.effect?.getTiming().iterations !== Infinity
      )
    await Promise.allSettled(transitions.map((animation) => animation.finished))
  })

const expectStableCard = async (card: Locator, frame: string): Promise<void> => {
  await waitForCardTransitions(card)
  const screenPixels = async (): Promise<Buffer> =>
    sharp(await card.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer()
  const settled = await screenPixels()
  for (let sample = 0; sample < 3; sample++) {
    await card.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(await pixels(card.locator('canvas'))).toBe(frame)
    const current = await screenPixels()
    expect(current.length).toBe(settled.length)
    // Include the mask and controls, allowing two levels of compositor rounding per channel.
    expect(current.some((value, i) => Math.abs(value - settled[i]) > 2)).toBe(false)
  }
}

test('animates only the hovered Silk card and keeps keyboard focus visually stable', async ({
  app
}, info) => {
  const { page } = app
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.locator('[data-onboarding-action="next"]').click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const header = connect.locator('header')
  await header.hover()
  const card = connect.locator('.onboarding-provider-card-anthropic')
  const control = connect.locator('.onboarding-provider-card-openai')
  const canvas = card.locator('canvas')
  const otherCanvas = control.locator('canvas')
  const tray = card.locator('.onboarding-provider-card-actions')
  const idle = await pixels(canvas)
  const otherIdle = await pixels(otherCanvas)
  await expectStableCard(card, idle)
  await card.screenshot({ path: info.outputPath('anthropic-idle.png') })

  await card.hover()
  await expect.poll(() => pixels(canvas)).not.toBe(idle)
  const moving = await pixels(canvas)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
  await expect.poll(() => pixels(canvas)).not.toBe(moving)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
  await expect(tray).toHaveCSS('opacity', '1')
  await card.screenshot({ path: info.outputPath('anthropic-hover.png') })

  await header.hover()
  await expect(tray).toHaveCSS('opacity', '0')
  const stopped = await pixels(canvas)
  expect(stopped).not.toBe(idle)
  await expectStableCard(card, stopped)

  // Tab through the carousel as a keyboard user while the pointer remains on the header.
  const focusable = await connect.locator('button:enabled, input:enabled').count()
  for (let i = 0; i < focusable && !(await card.locator(':focus').count()); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(card.locator(':focus')).toBeFocused()
  await expect(tray).toHaveCSS('opacity', '1')
  await expectStableCard(card, stopped)
  expect(await pixels(otherCanvas)).toBe(otherIdle)
})

test('keeps the provider tray translucent in both themes and sizes each step to its content', async ({
  app
}) => {
  const { page } = app
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  const connect = page.locator('[data-onboarding-entry="connect"]')
  const header = connect.locator('header')
  const card = connect.locator('.onboarding-provider-card-anthropic')
  const silk = card.locator('.onboarding-provider-silk')
  const tray = card.locator('.onboarding-provider-card-actions')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect
      .poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark')))
      .toBe(colorScheme === 'dark')
    await header.hover()
    await expect(card).toHaveCSS('background-color', 'rgb(26, 26, 25)')
    await expect(card).toHaveCSS('background-size', '180% 180%')
    await expect(silk).toHaveCSS('opacity', '0.52')
    await card.hover()
    await expect(silk).toHaveCSS('opacity', '0.68')
    await expect(tray).toHaveCSS('opacity', '1')
    await expect(tray).toHaveCSS('border-top-width', '0px')
    await expect(tray).toHaveCSS('backdrop-filter', 'blur(18px) saturate(1.12)')
    await expect(tray).toHaveCSS('background-image', /linear-gradient\(.*0\.46\)\)/)
  }

  const feedback = connect.locator('.onboarding-quick-feedback')
  await expect(feedback).toHaveCSS('overflow-y', 'auto')
  await expect(feedback.locator('footer')).toHaveCSS('margin-top', '0px')
  expect(await connect.evaluate((el) => el.computedStyleMap().get('height')?.toString())).toBe(
    'auto'
  )
  expect(await connect.evaluate((el) => el.computedStyleMap().get('min-height')?.toString())).toBe(
    'auto'
  )
  expect(await connect.evaluate((el) => getComputedStyle(el).maxHeight)).toBe(
    await page
      .getByRole('dialog', { name: 'Open-Science onboarding' })
      .evaluate((el) => getComputedStyle(el).maxHeight)
  )
  await connect.getByRole('button', { name: 'Advanced options' }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: /^(Skip|Use configured provider)$/ }).click()
  await page.getByRole('button', { name: 'Finish', exact: true }).click()
  const readyActions = page.locator('[data-onboarding-entry="ready"] .onboarding-ready-actions')
  await expect(readyActions).toBeVisible()
  expect(
    await readyActions.evaluate((el) => el.computedStyleMap().get('margin-top')?.toString())
  ).toBe('auto')
})

test('exposes quick-connect actions on the first tap on touch-only devices', async ({ app }) => {
  const { page } = app
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    expect(
      await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)
    ).toBe(true)
    const card = page.locator('.onboarding-provider-card-anthropic')
    const tray = card.locator('.onboarding-provider-card-actions')
    await expect(tray).toHaveCSS('opacity', '1')
    await expect(tray).toHaveCSS('pointer-events', 'auto')
    const action = card.getByRole('button', { name: 'Have an API key?' })
    await action.scrollIntoViewIfNeeded()
    const bounds = (await action.boundingBox())!
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }]
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(card.getByLabel('API key', { exact: true })).toBeVisible()
  } finally {
    await cdp.detach()
  }
})
