import { expect, test } from '@playwright/test'

for (const runtime of [false, true]) {
  test(`pre-install occupancy instructions retain the quit warning (${runtime ? 'runtime' : 'legacy'})`, async ({
    page
  }, testInfo) => {
    await page.goto(`/update-dialog.html?manual&occupancy${runtime ? '&runtime' : ''}`)
    const entry = page.getByRole('button', { name: 'Install manually…', exact: true })
    await entry.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveAccessibleName('Install manually')
    const warning = dialog.getByRole('alert')
    await expect(warning).toContainText('Completely quit Open-Science')
    await expect(warning).toContainText('close other instances or stop services')
    await expect(warning).toContainText('Manual installation does not release files')
    await expect(dialog).not.toContainText('Ready for manual installation')
    await dialog.getByRole('button', { name: 'Show in File Explorer', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-manual-reveals', '1')
    await page.screenshot({
      path: testInfo.outputPath(`occupancy-${runtime ? 'runtime' : 'legacy'}.png`)
    })
    await dialog.getByRole('button', { name: 'Use a new download instead' }).click()
    await expect(warning).toContainText('Completely quit Open-Science')
    await page.keyboard.press('Escape')
    await expect(entry).toBeFocused()
    await entry.click()
    await expect(dialog.getByRole('button', { name: 'Show in File Explorer' })).toBeEnabled()
    await page.evaluate(() => document.dispatchEvent(new Event('manual-fixture-native-pending')))
    await expect(page.getByRole('button', { name: 'Show in File Explorer' })).toHaveCount(0)
    await expect(entry).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Check installation', exact: true })).toHaveCount(
      0
    )
    await expect(page.getByRole('button', { name: 'Quit', exact: true })).toBeEnabled()
    await expect(page.getByRole('dialog')).toContainText('This app cannot check its progress.')
    await page.screenshot({
      path: testInfo.outputPath(`unknown-handoff-${runtime ? 'runtime' : 'legacy'}.png`)
    })
    expect(page.context().pages()).toHaveLength(1)
  })
}

test('recovers historical records only after confirmation in the update dialog', async ({
  page
}, testInfo) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await page
    .getByTestId('runtime-update-dialog')
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
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
    page
      .getByRole('dialog', { name: 'Update', exact: true })
      .getByText('Please wait for the app to close and reopen.', { exact: false })
  ).toBeVisible()
  await expect(recover).toBeHidden()
})

test('keeps the update dialog open when Escape arrives during recovery autofocus', async ({
  page
}, testInfo) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await page
    .getByTestId('runtime-update-dialog')
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
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
  await page
    .getByTestId('runtime-update-dialog')
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
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

test(`keeps one update dialog and release notes through download and preparation`, async ({
  page
}, testInfo) => {
  await page.goto(`/update-dialog.html?continuous&short&locale=en`)
  const dialog = page.getByRole('dialog')
  const original = await dialog.elementHandle()
  const notes = 'Release note 1:'
  await expect(dialog).toContainText(notes)
  await dialog.getByRole('button', { name: /^Download update/ }).click()
  const restart = dialog.getByRole('button', {
    name: 'Restart to update',
    exact: true
  })
  await expect(restart).toBeVisible()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[role="dialog"]'))
  ).toBe(true)
  await expect(dialog).toContainText(notes)
  await expect(dialog.locator('details')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath(`unified-update-ready-en.png`) })
  await restart.click()
  await expect(dialog).toContainText('Preparing update')
  await expect(dialog).toContainText(notes)
  expect(
    await original!.evaluate((node) => node === document.querySelector('[role="dialog"]'))
  ).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`unified-update-preparing-en.png`) })
})

test('keeps the shared restart action visible with long notes in a small window', async ({
  page
}) => {
  await page.setViewportSize({ width: 560, height: 420 })
  await page.goto('/update-dialog.html?continuous')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /^Download update/ }).click()
  const restart = dialog.getByRole('button', { name: 'Restart to update', exact: true })
  await expect(restart).toBeInViewport()
  await expect(dialog).toContainText('Release note 35:')
  await dialog.getByText('Release note 35:', { exact: false }).scrollIntoViewIfNeeded()
  await expect(restart).toBeInViewport()
})

for (const width of [320, 375, 414, 768]) {
  test(`keeps update status and actions visible while notes scroll at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 620 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/update-dialog.html?continuous&stage=downloading')
    const dialog = page.getByRole('dialog')
    const status = page.getByTestId('update-status')
    const progress = dialog.getByRole('progressbar')
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
    const before = await status.boundingBox()
    await dialog.getByText('Release note 35:', { exact: false }).scrollIntoViewIfNeeded()
    await expect(progress).toBeInViewport()
    await expect(cancel).toBeInViewport()
    expect(await status.boundingBox()).toEqual(before)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}

for (const theme of ['light', 'dark']) {
  test(`shows installation feedback without a cancellable action (${theme})`, async ({
    page
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`/update-dialog.html?continuous&short&stage=installing&${theme}`)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('status')).toContainText(
      'Cannot cancel; the app will reopen automatically.'
    )
    await expect(
      dialog.getByRole('button', { name: 'Installing update…', exact: true })
    ).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('region', { name: "What's new" })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`update-installing-${theme}.png`) })
  })
}

test(`keeps status copy on one line and scrolls long notes independently`, async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/update-dialog.html?continuous&stage=installing&locale=en`)
  const dialog = page.getByRole('dialog')
  const status = page.getByTestId('update-status')
  const body = page.getByTestId('update-scroll-body')
  const action = dialog.getByRole('button')
  await expect(status).toBeVisible()
  const description = status.locator('p')
  expect(
    await description.evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getClientRects().length
    })
  ).toBe(1)
  const before = { status: await status.boundingBox(), action: await action.boundingBox() }
  expect((await dialog.boundingBox())!.height).toBeLessThan(650)
  await body.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  expect(await status.boundingBox()).toEqual(before.status)
  expect(await action.boundingBox()).toEqual(before.action)
  await expect(action).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath(`bounded-update-notes-en.png`) })
})

test('keeps provider check feedback visible without download or installation actions', async ({
  page
}) => {
  await page.goto('/update-dialog.html?continuous&stage=checking&locale=en')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('status')).toContainText('Checking for updates…')
  await expect(dialog.getByRole('button', { name: /^Download update/ })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Restart to update', exact: true })).toHaveCount(
    0
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
})
for (const runtime of [false, true]) {
  test(`manual instructions restore entry focus with Back and Escape (${runtime ? 'runtime' : 'legacy'})`, async ({
    page
  }) => {
    await page.goto(`/update-dialog.html?manual${runtime ? '&runtime' : ''}`)
    const entry = page.getByRole('button', { name: 'Install manually…', exact: true })
    await entry.click()
    const manual = page.getByRole('dialog', { name: 'Install manually', exact: true })
    await expect(manual).toBeVisible()
    await expect(manual.locator('ol li')).toHaveCount(3)
    await expect(
      manual.getByRole('button', { name: 'Show in File Explorer', exact: true })
    ).toBeEnabled()
    await manual.getByRole('button', { name: 'Back to update', exact: true }).click()
    await expect(entry).toBeFocused()
    await entry.click()
    await expect(
      manual.getByRole('button', { name: 'Show in File Explorer', exact: true })
    ).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(entry).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(1)
  })
}

for (const dark of [false, true]) {
  test(`manual instructions wrap long filenames and keep actions fixed (${dark ? 'dark' : 'light'})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 560, height: 420 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(`/update-dialog.html?manual${dark ? '&dark' : ''}`)
    await page.getByRole('button', { name: 'Install manually…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Install manually', exact: true })
    const reveal = dialog.getByRole('button', { name: 'Show in File Explorer', exact: true })
    await expect(reveal).toBeEnabled()
    await expect(reveal).toBeInViewport()
    await page.screenshot({
      path: testInfo.outputPath(`manual-${dark ? 'dark' : 'light'}-filename.png`)
    })
    const before = await reveal.boundingBox()
    const scroll = dialog.locator('[data-slot="scroll-area-viewport"]')
    expect(
      await scroll.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1)
    await scroll.hover()
    await page.mouse.wheel(0, 1000)
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect(await reveal.boundingBox()).toEqual(before)
    await expect(
      dialog.getByRole('button', { name: 'Use a new download instead' })
    ).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`manual-${dark ? 'dark' : 'light'}.png`) })
    await reveal.click()
    await expect(page.locator('body')).toHaveAttribute('data-manual-reveals', '1')
    await expect(reveal).toBeEnabled()
    expect(page.context().pages()).toHaveLength(1)
  })
}

test('manual checks coalesce and old artifact replies cannot replace a new target', async ({
  page
}) => {
  await page.goto('/update-dialog.html?manual')
  await page.getByRole('button', { name: 'Install manually…', exact: true }).dblclick()
  await expect(page.locator('body')).toHaveAttribute('data-manual-checks', '1')
  await expect(
    page.getByRole('button', { name: 'Checking installer…', exact: true })
  ).toBeDisabled()
  await page.evaluate(() => document.dispatchEvent(new Event('manual-fixture-target-change')))
  await expect(page.getByRole('dialog')).toContainText('v0.30.0')
  await expect(page.getByRole('button', { name: 'Install manually…', exact: true })).toBeVisible()
  // Resolve the fixture's delayed reply before asserting the obsolete instructions stay absent.
  await page.waitForTimeout(200)
  await expect(
    page.getByRole('button', { name: 'Show in File Explorer', exact: true })
  ).toHaveCount(0)
})

test('invalidated cached installer switches to complete website instructions without opening a browser', async ({
  page
}) => {
  await page.goto('/update-dialog.html?manual&invalid')
  await page.getByRole('button', { name: 'Install manually…', exact: true }).click()
  await page.getByRole('button', { name: 'Show in File Explorer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Download the full installer', exact: true })
  const download = dialog.getByRole('link', { name: 'Download from website', exact: true })
  await expect(download).toHaveAttribute('href', 'https://www.aipoch.com/open-science/download')
  await expect(dialog.locator('ol li')).toHaveCount(3)
  await expect(
    dialog.getByRole('button', { name: 'Show in File Explorer', exact: true })
  ).toHaveCount(0)
  expect(page.context().pages()).toHaveLength(1)
})

for (const failure of ['website', 'download-failed']) {
  test(`website fallback stays in app until explicit download (${failure})`, async ({
    page,
    context
  }) => {
    await page.goto(`/update-dialog.html?manual&${failure}`)
    await page
      .getByRole('button', {
        name: failure === 'website' ? 'Get the full installer…' : 'Download manually…',
        exact: true
      })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Download the full installer', exact: true })
    await expect(dialog.locator('ol li')).toHaveCount(3)
    await expect(dialog.getByText('Quit Open-Science', { exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Show in File Explorer', exact: true })
    ).toHaveCount(0)
    expect(context.pages()).toHaveLength(1)
    await context.route('https://www.aipoch.com/open-science/download', (route) =>
      route.fulfill({ body: 'Download page' })
    )
    const popup = page.waitForEvent('popup')
    await dialog.getByRole('link', { name: 'Download from website', exact: true }).click()
    await expect(await popup).toHaveURL('https://www.aipoch.com/open-science/download')
  })
}

// The restart channel owns download failures in the unified RuntimeUpdateDialog.
test('restart download failure enters manual instructions in the same dialog', async ({ page }) => {
  await page.goto('/update-dialog.html?manual&runtime&download-failed')
  const dialog = page.getByTestId('runtime-update-dialog')
  const original = await dialog.elementHandle()
  await expect(dialog.getByRole('button', { name: 'Retry download', exact: true })).toBeVisible()
  const entry = dialog.getByRole('button', { name: 'Download manually…', exact: true })
  await entry.click()
  await expect(
    dialog.getByRole('link', { name: 'Download from website', exact: true })
  ).toBeVisible()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[role="dialog"]'))
  ).toBe(true)
  expect(page.context().pages()).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Back to update', exact: true }).click()
  await expect(entry).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Retry download', exact: true })).toBeVisible()
})
