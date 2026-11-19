import { OFFICIAL_VENDORS } from '@aipoch/providers'
import { expect } from '@playwright/test'
import type { Locator } from 'playwright'
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

test('shows Silk on every provider and advances only the hovered texture', async ({
  app
}, info) => {
  const page = app.page
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.locator('[data-onboarding-action="next"]').click()
  const heading = page.getByRole('heading', { name: 'Bring the AI you already use.' })
  await heading.hover()
  const canvases = page.locator('.onboarding-provider-silk canvas')
  await expect(canvases).toHaveCount(OFFICIAL_VENDORS.length + 1)
  const canvasesToRead = await canvases.all()
  const allFrames = (): Promise<string[]> => Promise.all(canvasesToRead.map(pixels))
  const idle = await allFrames()
  const card = page.locator('.onboarding-provider-card-anthropic')
  const canvas = card.locator('canvas')
  const index = OFFICIAL_VENDORS.findIndex((vendor) => vendor.id === 'anthropic')
  await card.screenshot({ path: info.outputPath('anthropic-idle.png') })
  expect(await allFrames()).toEqual(idle)
  await card.hover()
  await expect.poll(() => pixels(canvas)).not.toBe(idle[index])
  const moving = await pixels(canvas)
  await expect.poll(() => pixels(canvas)).not.toBe(moving)
  await card.screenshot({ path: info.outputPath('anthropic-hover.png') })
  await heading.hover()
  const stopped = await allFrames()
  expect(stopped.filter((_, i) => i !== index)).toEqual(idle.filter((_, i) => i !== index))
  // Sample across multiple presented frames; leaving must freeze the last pose, not reset it.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  )
  expect(await allFrames()).toEqual(stopped)
  expect(stopped[index]).not.toBe(idle[index])
})
