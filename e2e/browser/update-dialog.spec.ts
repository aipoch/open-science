import { expect, test } from '@playwright/test'

test('recovers historical records only after confirmation in the update dialog', async ({
  page
}) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await dialog.getByRole('button', { name: 'Restart to update', exact: true }).click()
  const recover = dialog.getByRole('button', { name: 'Back up records and retry', exact: true })
  await expect(recover).toBeInViewport()
  page.once('dialog', (confirmation) => confirmation.dismiss())
  await recover.click()
  await expect(recover).toBeEnabled()
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('cannot verify whether commands')
    await confirmation.accept()
  })
  await recover.click()
  await expect(
    dialog.getByText('Open Science is stopping background tasks', { exact: false })
  ).toBeVisible()
  await expect(recover).toBeHidden()
})

test('shows a refused restart reason without scrolling through release notes', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/update-dialog.html?refused-restart')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await dialog.getByRole('button', { name: 'Restart to update', exact: true }).click()
  const error = dialog.getByRole('alert')
  await expect(error).toContainText('Could not fully stop background processes before updating.')
  await expect(dialog.getByRole('button', { name: 'Restart to update', exact: true })).toBeEnabled()
  await expect(error).toBeInViewport()
})

for (const size of [
  { width: 1000, height: 720 },
  { width: 560, height: 420 }
]) {
  test(`keeps progress and actions fixed while release notes scroll at ${size.width}x${size.height}`, async ({
    page
  }) => {
    await page.setViewportSize(size)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/update-dialog.html')
    const dialog = page.getByRole('dialog', { name: 'Update available' })
    const notes = dialog.locator('[data-slot="scroll-area-viewport"]')
    const progress = dialog.getByRole('progressbar', { name: 'Download progress' })
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const download = dialog.getByRole('button', { name: 'Downloading 99%' })
    await expect(progress).toBeInViewport()
    await expect(cancel).toBeInViewport()
    await expect(download).toBeInViewport()
    const progressBefore = await progress.boundingBox()
    const cancelBefore = await cancel.boundingBox()
    const downloadBefore = await download.boundingBox()

    await notes.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => notes.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect(await progress.boundingBox()).toEqual(progressBefore)
    expect(await cancel.boundingBox()).toEqual(cancelBefore)
    expect(await download.boundingBox()).toEqual(downloadBefore)
    expect(await dialog.evaluate((node) => node.scrollTop)).toBe(0)

    await notes.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await expect(notes.getByText('View full release notes on GitHub')).toBeInViewport()
    expect(await progress.boundingBox()).toEqual(progressBefore)
    await cancel.click()
    await expect(dialog).toBeHidden()
  })
}

test('keeps short release notes compact', async ({ page }) => {
  await page.goto('/update-dialog.html?short')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await expect(dialog).toBeVisible()
  const notes = dialog.locator('[data-slot="scroll-area-viewport"]')
  expect(await notes.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(
    1
  )
  expect((await dialog.boundingBox())!.height).toBeLessThan(450)
})
