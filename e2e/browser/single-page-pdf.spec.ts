import { expect, test } from '@playwright/test'

for (const rotated of [false, true]) {
  test(`single-page PDF fits, zooms and pans like an image (rotated=${rotated})`, async ({
    page
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 800, height: 650 })
    await page.goto(`/single-page-pdf.html${rotated ? '?rotated' : ''}`)
    const canvas = page.getByRole('img', { name: 'figure.pdf' })
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
      .toBeGreaterThan(0)
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => element.width / element.height)
    ).toBeCloseTo(rotated ? 2 / 3 : 3 / 2)
    // A real non-white pixel proves painting completed, beyond canvas dimensions alone.
    expect(
      await canvas.evaluate((element: HTMLCanvasElement) => {
        const pixels = element
          .getContext('2d')!
          .getImageData(0, 0, element.width, element.height).data
        return pixels.some((value, index) => index % 4 !== 3 && value < 200)
      })
    ).toBe(true)
    await expect(page.locator('[data-pdf-controls]')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(0)
    const transform = page.locator('.react-transform-component')
    const initialWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width)
    const initial = await transform.getAttribute('style')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect(transform).not.toHaveAttribute('style', initial!)
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width))
      .toBeGreaterThan(initialWidth)
    const zoomed = await transform.getAttribute('style')
    await page.mouse.move(350, 300)
    await page.mouse.down()
    await page.mouse.move(440, 340, { steps: 8 })
    await page.mouse.up()
    await expect(transform).not.toHaveAttribute('style', zoomed!)
    // The shared image viewer aligns pan bounds asynchronously after mouseup.
    let previousStyle = ''
    let stableSamples = 0
    await expect
      .poll(
        async () => {
          const style = (await transform.getAttribute('style')) ?? ''
          stableSamples = style === previousStyle ? stableSamples + 1 : 0
          previousStyle = style
          return stableSamples
        },
        { intervals: [100] }
      )
      .toBeGreaterThanOrEqual(3)
    await page.getByRole('button', { name: 'Reset zoom', exact: true }).click()
    await expect(transform).toHaveAttribute('style', initial!)
    await page.setViewportSize({ width: 420, height: 750 })
    await expect(canvas).toBeVisible()
    await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: 'Two pages', exact: true }).click()
    await expect(page.locator('[data-pdf-preview-root]')).toBeVisible()
    await expect(page.locator('[data-pdf-controls="interaction"]')).toBeVisible()
    await page.getByRole('button', { name: 'Single page', exact: true }).click()
    await expect(canvas).toBeVisible()
    await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
