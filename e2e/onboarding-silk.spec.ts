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
