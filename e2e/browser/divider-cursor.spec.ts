import { expect, test } from '@playwright/test'

for (const vertical of [false, true]) {
  test(`scopes ${vertical ? 'vertical' : 'horizontal'} drag cursors and restores them`, async ({
    page
  }) => {
    await page.setViewportSize({ width: 1000, height: 760 })
    await page.goto(`/divider-cursor.html${vertical ? '?vertical' : ''}`)
    const handle = page.getByRole('separator', { name: 'Resize fixture' })
    await expect(handle).toBeVisible()
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const axis = vertical ? 'y' : 'x'
    const move = (delta: number): Promise<void> =>
      page.mouse.move(x + (vertical ? 0 : delta), y + (vertical ? delta : 0), { steps: 5 })
    // Exercise both sides of the expanded hit target, including the neighboring iframe.
    await move(-8)
    await expect(handle).toHaveAttribute('data-separator', 'hover')
    await expect(page.getByRole('button', { name: 'Unrelated action' })).toHaveCSS(
      'cursor',
      'pointer'
    )
    await page.mouse.down()
    await move(50)
    await expect(handle).toHaveAttribute('data-separator', 'active')
    await expect
      .poll(async () => (await handle.boundingBox())![axis] - box[axis])
      .toBeGreaterThan(40)
    await expect(handle).toHaveCSS('cursor', vertical ? 'ns-resize' : 'ew-resize')
    // Reach each constraint, then return to the original size in the same drag.
    await move(350)
    await move(360)
    await expect(handle).toHaveCSS('cursor', vertical ? 'n-resize' : 'w-resize')
    await expect(page.getByRole('button', { name: 'Unrelated action' })).toHaveCSS(
      'cursor',
      'pointer'
    )
    await move(-350)
    await move(-360)
    await expect(handle).toHaveCSS('cursor', vertical ? 's-resize' : 'e-resize')
    await move(-8)
    await expect.poll(async () => (await handle.boundingBox())![axis]).toBeCloseTo(box[axis], 0)
    await page.mouse.up()
    await page.getByRole('button', { name: 'Unrelated action' }).hover()
    await expect(page.locator('[data-resize-cursor]')).toHaveCount(0)
    await expect(page.getByText('Synthetic text')).toHaveCSS('cursor', 'text')
    await handle.focus()
    await page.keyboard.press(vertical ? 'ArrowDown' : 'ArrowRight')
    await expect
      .poll(async () => (await handle.boundingBox())![axis])
      .toBeGreaterThan(box[axis] + 10)
    await expect(page.locator('[data-resize-cursor]')).toHaveCount(0)
  })
}

test('clears the cursor when a touch drag is cancelled', async ({ page }) => {
  await page.goto('/divider-cursor.html')
  const handle = page.getByRole('separator', { name: 'Resize fixture' })
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...start, x: start.x + 50 }]
  })
  await expect(handle).toHaveAttribute('data-separator', 'active')
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  await expect(handle).not.toHaveAttribute('data-separator', 'active')
  await expect(page.locator('[data-resize-cursor]')).toHaveCount(0)
  await expect(handle).not.toHaveCSS('cursor', /resize/)
})

test('clears the cursor on movement after a prevented pointer release', async ({ page }) => {
  await page.goto('/divider-cursor.html')
  const handle = page.getByRole('separator', { name: 'Resize fixture' })
  await expect(handle).toBeVisible()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 10 })
  await expect(handle).toHaveAttribute('data-separator', 'active')
  await page.evaluate(() => {
    window.addEventListener('pointerup', (event) => event.preventDefault(), {
      capture: true,
      once: true
    })
  })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Unrelated action' }).hover()
  await expect(handle).not.toHaveAttribute('data-separator', 'active')
  await expect(page.locator('[data-resize-cursor]')).toHaveCount(0)
})
