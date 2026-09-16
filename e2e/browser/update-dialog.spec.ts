import { expect, test } from '@playwright/test'

test('recovers historical records only after confirmation in the update dialog', async ({
  page
}, testInfo) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await dialog.getByRole('button', { name: 'Restart to update', exact: true }).click()
  const recover = dialog.getByRole('button', { name: 'Back up records and retry', exact: true })
  await expect(recover).toBeInViewport()
  await recover.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Back up records and retry' })
  await expect(confirmation).toBeVisible()
  await expect(confirmation).toContainText('cannot verify whether commands')
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeFocused()
  await cancel.click()
  await expect(confirmation).toBeHidden()
  await expect(recover).toBeEnabled()
  await expect(recover).toBeFocused()
  await recover.click()
  await expect(confirmation).toBeVisible()
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden()
  await expect(recover).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('update-confirmation-cancelled.png') })
  await recover.click()
  await confirmation.getByRole('button', { name: 'Back up records and retry', exact: true }).click()
  await expect(
    dialog.getByText('Open Science is stopping background tasks', { exact: false })
  ).toBeVisible()
  await expect(recover).toBeHidden()
})

test('keeps the update dialog open when Escape arrives during recovery autofocus', async ({
  page
}, testInfo) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await dialog.getByRole('button', { name: 'Restart to update', exact: true }).click()
  const recover = dialog.getByRole('button', { name: 'Back up records and retry', exact: true })
  const confirmation = page.getByRole('alertdialog', { name: 'Back up records and retry' })
  const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true })
  await recover.click()
  await expect(cancel).toBeFocused()
  await cancel.click()
  await expect(confirmation).toBeHidden()
  await expect(recover).toBeFocused()

  // Dispatch at real autofocus, before Radix can transfer its document Escape listener.
  await page.evaluate(() => {
    const escapeOnFocus = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLButtonElement) || !target.closest('[role="alertdialog"]')) return
      document.removeEventListener('focusin', escapeOnFocus, true)
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true
        })
      )
    }
    document.addEventListener('focusin', escapeOnFocus, true)
  })
  await recover.click()
  await expect(confirmation).toBeHidden()
  await expect(recover).toBeFocused()
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('recovery-escape.png') })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
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
