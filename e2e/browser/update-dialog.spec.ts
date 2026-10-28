import { expect, test } from '@playwright/test'

test('recovers historical records only after confirmation in the update dialog', async ({
  page
}, testInfo) => {
  await page.goto('/update-dialog.html?refused-restart&legacy')
  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await page
    .getByTestId('runtime-update-dialog')
    .getByRole('button', { name: 'Update', exact: true })
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
    .getByRole('button', { name: 'Update', exact: true })
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
    .getByRole('button', { name: 'Update', exact: true })
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
    name: 'Update',
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
  const restart = dialog.getByRole('button', { name: 'Update', exact: true })
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
  const action = dialog.getByRole('button', { name: 'Installing update…', exact: true })
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

for (const width of [320, 560]) {
  test(`keeps manual resources fixed and aligned above update controls at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 620 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/update-dialog.html?continuous&stage=downloading')
    const dialog = page.getByRole('dialog')
    const resources = dialog.getByTestId('manual-update-links')
    const website = resources.getByRole('link', { name: 'Download from website', exact: true })
    const instructions = resources.getByRole('button', {
      name: 'Installation instructions',
      exact: true
    })
    const primary = dialog.getByRole('button', { name: 'Downloading 50%', exact: true })
    await expect(website).toHaveAttribute('href', 'https://aipoch.com/open-science/download')
    await expect(website).toBeInViewport()
    await expect(instructions).toBeInViewport()
    const before = await resources.boundingBox()
    const linkBox = (await instructions.boundingBox())!
    const primaryBox = (await primary.boundingBox())!
    expect(Math.abs(linkBox.x + linkBox.width - primaryBox.x - primaryBox.width)).toBeLessThan(1)
    expect(linkBox.y + linkBox.height).toBeLessThanOrEqual(primaryBox.y)
    await dialog.getByText('Release note 35:', { exact: false }).scrollIntoViewIfNeeded()
    expect(await resources.boundingBox()).toEqual(before)
    await expect(instructions).toBeInViewport()
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  })
}

test('switches instructions in the same dialog and returns focus with the latest download state', async ({
  page
}) => {
  await page.goto('/update-dialog.html?continuous&stage=downloading')
  const dialog = page.getByRole('dialog')
  const original = await dialog.elementHandle()
  const instructions = dialog
    .getByTestId('manual-update-links')
    .getByRole('button', { name: 'Installation instructions', exact: true })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await instructions.focus()
  await page.keyboard.press('Enter')
  const back = dialog.getByRole('button', { name: 'Back to update', exact: true })
  await expect(back).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(dialog).toHaveAccessibleName('Installation instructions')
  await page.evaluate(() => {
    const fixture = (
      window as unknown as { updateFixture: { setStatus(status: { state: 'ready' }): void } }
    ).updateFixture
    fixture.setStatus({ state: 'ready' })
  })
  await page.keyboard.press('Escape')
  await expect(instructions).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
  expect(
    await original!.evaluate((node) => node === document.querySelector('[role="dialog"]'))
  ).toBe(true)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { updateFixture: { actions: Record<string, number> } }).updateFixture
          .actions
    )
  ).toEqual({ download: 0, apply: 0, cancel: 0, recover: 0, check: 0, reveal: 0 })
})

test('keeps manual instructions and package reveal available during restricted installation recovery', async ({
  page
}) => {
  await page.goto('/update-dialog.html?continuous&short&stage=unknown&package')
  const dialog = page.getByRole('dialog')
  const resources = dialog.getByTestId('manual-update-links')
  const reveal = resources.getByRole('button', { name: 'Show in Finder', exact: true })
  await expect(reveal).toBeVisible()
  await reveal.click()
  await resources.getByRole('button', { name: 'Installation instructions', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('An installer may still be running')
  await expect(dialog.getByText('Open-Science-1.0.12-mac-arm64.zip', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Unzip the file.', { exact: false })).toBeVisible()
  await dialog.getByRole('button', { name: 'Back to update', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { updateFixture: { actions: Record<string, number> } }).updateFixture
          .actions
    )
  ).toEqual({ download: 0, apply: 0, cancel: 0, recover: 0, check: 0, reveal: 1 })
})

test('returns from About instructions on Escape without closing Settings', async ({ page }) => {
  await page.goto('/update-dialog.html?settings&continuous&short')
  const dialog = page.getByRole('dialog', { name: 'General', exact: true })
  const instructions = dialog
    .getByTestId('manual-update-links')
    .getByRole('button', { name: 'Installation instructions', exact: true })
  await instructions.click()
  await expect(dialog.getByRole('button', { name: 'Back to settings', exact: true })).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(instructions).toBeFocused()
  await expect(dialog.getByText('About', { exact: true })).toBeVisible()
})

test('offers manual links in check failure prose and preserves retry without release notes', async ({
  page
}) => {
  await page.goto('/update-dialog.html?continuous&stage=check-error')
  const dialog = page.getByRole('dialog')
  const notice = dialog.locator('section').filter({ has: page.getByRole('alert') })
  await expect(notice).toContainText('Could not reach the update server.')
  await expect(
    notice.getByRole('link', { name: 'download from the website', exact: true })
  ).toBeVisible()
  await expect(
    notice.getByRole('button', { name: 'installation instructions', exact: true })
  ).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(dialog.getByRole('region', { name: "What's new" })).toHaveCount(0)
  await expect(dialog.getByTestId('manual-update-links')).toBeVisible()
})

for (const query of ['continuous&stage=downloading', 'short']) {
  test(`returns from instructions when Escape arrives during Back autofocus (${query})`, async ({
    page
  }) => {
    await page.goto(`/update-dialog.html?${query}`)
    const dialog = page.getByRole('dialog')
    const instructions = dialog
      .getByTestId('manual-update-links')
      .getByRole('button', { name: 'Installation instructions', exact: true })
    await page.evaluate(() => {
      const escapeOnFocus = (event: FocusEvent): void => {
        const target = event.target
        if (
          !(target instanceof HTMLButtonElement) ||
          target.getAttribute('aria-label') !== 'Back to update'
        )
          return
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
    await instructions.click()
    await expect(dialog.getByRole('button', { name: 'Back to update', exact: true })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(instructions).toBeFocused()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { updateFixture: { actions: Record<string, number> } })
            .updateFixture.actions
      )
    ).toEqual({ download: 0, apply: 0, cancel: 0, recover: 0, check: 0, reveal: 0 })
  })
}

for (const width of [320, 560]) {
  test(`aligns About manual links with version text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 })
    await page.goto('/update-dialog.html?settings&continuous&short')
    const dialog = page.getByRole('dialog', { name: 'General', exact: true })
    const appName = dialog.getByText('Open-Science', { exact: true })
    const resources = dialog.getByTestId('manual-update-links')
    const website = resources.getByRole('link', { name: 'Download from website', exact: true })
    const identityBox = (await appName.boundingBox())!
    const linkBox = (await website.boundingBox())!
    expect(Math.abs(identityBox.x - linkBox.x)).toBeLessThan(1)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  })
}

test('keeps instructions open when a background update leaves the legacy error surface', async ({
  page
}) => {
  await page.goto('/update-dialog.html?continuous&stage=ready&short')
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        updateFixture: { setStatus(status: { state: 'ready'; error: string }): void }
      }
    ).updateFixture
    fixture.setStatus({ state: 'ready', error: 'The update action could not be completed.' })
  })
  const dialog = page.getByRole('dialog')
  await dialog
    .getByTestId('manual-update-links')
    .getByRole('button', { name: 'Installation instructions', exact: true })
    .click()
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        updateFixture: { setStatus(status: { state: 'available'; error: undefined }): void }
      }
    ).updateFixture
    fixture.setStatus({ state: 'available', error: undefined })
  })
  await expect(dialog).toHaveAccessibleName('Installation instructions')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const back = dialog.getByRole('button', { name: 'Back to update', exact: true })
  await expect(back).toBeFocused()
  await back.click()
  await expect(
    dialog
      .getByTestId('manual-update-links')
      .getByRole('button', { name: 'Installation instructions', exact: true })
  ).toBeFocused()
  await expect(dialog.getByRole('button', { name: /^Download update/ })).toBeVisible()
})

for (const navigation of ['keyboard', 'pointer']) {
  test(`returns from About instructions after ${navigation} focus leaves the guide`, async ({
    page
  }, testInfo) => {
    await page.goto('/update-dialog.html?settings&continuous&short')
    const dialog = page.getByRole('dialog', { name: 'General', exact: true })
    const instructions = dialog
      .getByTestId('manual-update-links')
      .getByRole('button', { name: 'Installation instructions', exact: true })
    await instructions.click()
    await expect(
      dialog.getByRole('button', { name: 'Back to settings', exact: true })
    ).toBeFocused()
    const surroundingControl = dialog.getByRole('button', { name: 'Appearance', exact: true })
    if (navigation === 'keyboard') await page.keyboard.press('Shift+Tab')
    else await surroundingControl.click()
    await expect(surroundingControl).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Back to settings', exact: true })).toHaveCount(
      0
    )
    await expect(instructions).toBeFocused()
    await page.screenshot({
      path: testInfo.outputPath(`settings-guide-escape-after-${navigation}.png`)
    })
  })
}
