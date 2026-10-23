import { expect, test } from '@playwright/test'

test('previews conflicting promotion, renames the child, then allows parent deletion', async ({
  page
}) => {
  await page.goto('/literature-recovery.html')
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete collection' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: 'Delete collection' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Rename conflicting collection' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit collection' })
  await editor.getByLabel('Name', { exact: true }).fill('Child review')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete collection' }).click()
  await expect(dialog.getByText('Child review', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete collection' }).click()
  await expect(page.getByRole('heading', { name: 'All references' })).toBeVisible()
})

test('retries one failed row while retaining the unchecked review', async ({ page }) => {
  await page.goto('/literature-recovery.html?mode=batch')
  await expect(
    page.getByText('The source could not be reached. Check the connection and retry.')
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry this reference' }).click()
  await expect(page.getByRole('button', { name: 'Retry this reference' })).toBeHidden()
  const state = await page.evaluate(
    () =>
      (
        window as unknown as {
          literatureRecovery: { commands: unknown[]; job: { rows: Array<{ checked: boolean }> } }
        }
      ).literatureRecovery
  )
  expect(state.commands).toContainEqual({
    action: 'retry-failed',
    jobId: '9323d39a-2ae2-49c8-8826-a589c78f1f5d',
    itemIds: ['failed']
  })
  expect(state.job.rows[1].checked).toBe(false)
})

const openFileDetail = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.goto('/literature-recovery.html?mode=files')
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page
    .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
    .dblclick()
  await expect(page.getByRole('dialog')).toBeVisible()
}

test('dismisses attachment menus with outside clicks and Escape without trapping the detail', async ({
  page
}) => {
  await openFileDetail(page)
  const detail = page.getByRole('dialog')
  const actions = detail.getByRole('button', { name: 'Attachment actions for original.pdf' })
  const heading = await detail
    .getByRole('heading', { name: 'A reference with supporting PDFs' })
    .boundingBox()
  await actions.click()
  await page.getByRole('menuitem', { name: 'Download', exact: true }).hover()
  await expect(page.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible()
  await page.mouse.click(heading!.x + 10, heading!.y + 10)
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(detail).toBeVisible()
  await actions.click()
  await page.getByRole('menuitem', { name: 'Download', exact: true }).hover()
  await page.mouse.click(5, 5)
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(detail).toBeVisible()
  await actions.click()
  await page.getByRole('menuitem', { name: 'Download', exact: true }).hover()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(actions).toBeFocused()
  await expect(detail).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
})

test('adds multiple PDFs through the picker and drop area and downloads from the attachment menu', async ({
  page
}) => {
  await openFileDetail(page)
  const detail = page.getByRole('dialog')
  const picker = detail.getByLabel('Add PDFs', { exact: true })
  await expect(picker).toHaveAttribute('multiple', '')
  await picker.setInputFiles(
    ['translation.pdf', 'supplement.pdf'].map((name) => ({
      name,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7')
    }))
  )
  await expect(
    detail.getByRole('button', { name: 'Preview translation.pdf', exact: true })
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: 'Preview supplement.pdf', exact: true })
  ).toBeVisible()
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    for (const name of ['methods.pdf', 'tables.pdf'])
      data.items.add(new File(['%PDF-1.7'], name, { type: 'application/pdf' }))
    return data
  })
  const zone = detail.locator('[data-slot="literature-pdf-drop-zone"]')
  await zone.dispatchEvent('dragenter', { dataTransfer: transfer })
  await expect(
    detail.getByText('Drop PDFs to attach to this reference', { exact: true })
  ).toBeVisible()
  await zone.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(
    detail.getByRole('button', { name: 'Preview tables.pdf', exact: true })
  ).toBeVisible()
  await expect(
    detail.getByRole('button', { name: 'Preview methods.pdf', exact: true })
  ).toBeVisible()
  await detail.getByRole('button', { name: 'Attachment actions for original.pdf' }).click()
  await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { literatureFiles: { requests: object[] } }).literatureFiles
            .requests
      )
    )
    .toContainEqual({
      source: 'literature',
      path: 'literature-attachment-version:original-v1',
      suggestedName: 'original.pdf'
    })
  await expect(detail).toBeVisible()
})

for (const width of [320, 375, 414, 768, 1000]) {
  test(`single-paper citation discovery at ${width}px`, async ({ page }) => {
    // Open the existing desktop table before exercising the detail at narrow widths.
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.goto('/literature-recovery.html?mode=files')
    await page.getByText('All references', { exact: true }).click()
    await page
      .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
      .click()
    const dialog = page.getByRole('dialog').first()
    await expect(dialog).toBeVisible()
    await page.setViewportSize({ width, height: 850 })
    await dialog.getByRole('button', { name: 'References', exact: true }).click()
    await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
    await dialog.getByRole('tab', { name: 'Cited by', exact: true }).click()
    await expect(dialog.getByText('A follow-up study', { exact: true })).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Select A follow-up study' }).check()
    await dialog.getByRole('button', { name: 'Load more' }).click()
    await expect(dialog.getByText('Another related paper', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Select A follow-up study' })).toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Semantic Scholar settings' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Semantic Scholar settings' }).click()
    const settings = dialog.getByRole('form', { name: 'Semantic Scholar settings' })
    const keyInput = settings.getByLabel('API key', { exact: true })
    await expect(keyInput).toBeFocused()
    await keyInput.pressSequentially('test-semantic-scholar-key')
    await settings.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(settings).not.toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Semantic Scholar settings' })).toBeFocused()
    await expect(dialog.getByText('Another related paper', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Select A follow-up study' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Semantic Scholar settings' }).click()
    await expect(keyInput).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(settings).not.toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Select A follow-up study' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Add selected to Inbox' }).click()
    await expect(dialog.getByText('In Inbox', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'References', exact: true })).toBeFocused()
    await expect(
      dialog.getByText('A reference with supporting PDFs', { exact: true })
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'References', exact: true }).click()
    await dialog.getByRole('button', { name: 'Semantic Scholar settings' }).click()
    await expect(keyInput).toBeFocused()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.setViewportSize({ width: 1000, height: 850 })
    await page
      .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
      .click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await page
      .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
      .click()
    await dialog.getByRole('button', { name: 'References', exact: true }).click()
    await dialog.getByRole('checkbox', { name: 'Select A foundational reference' }).check()
    await dialog.getByRole('button', { name: 'Add selected to Inbox' }).click()
    await dialog.getByRole('button', { name: 'Semantic Scholar settings' }).click()
    await dialog.getByRole('button', { name: 'Open Inbox' }).click()
    await expect(dialog).not.toBeVisible()
    await page.getByText('All references', { exact: true }).click()
    await page
      .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
      .click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
  })
}

test('configures a citation key directly from a rate-limit notice', async ({ page }) => {
  await page.goto('/literature-recovery.html?mode=files&citation-key')
  await page.getByText('All references', { exact: true }).click()
  await page.getByRole('button', { name: 'A reference with supporting PDFs', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  const notice = dialog.getByRole('alert')
  await expect(notice).toBeVisible()
  await page.evaluate(() => {
    const alert = document.querySelector('[role="alert"]')!
    Object.assign(window, { citationNotice: alert, citationLoadingFlashes: 0 })
    new MutationObserver((mutations) => {
      for (const mutation of mutations)
        for (const node of mutation.addedNodes)
          if (
            node instanceof Element &&
            (node.matches('[data-slot="citation-loading"]') ||
              node.querySelector('[data-slot="citation-loading"]'))
          )
            (window as unknown as { citationLoadingFlashes: number }).citationLoadingFlashes++
    }).observe(document.body, { childList: true, subtree: true })
  })
  for (const tab of ['Cited by', 'References', 'Cited by']) {
    await dialog.getByRole('tab', { name: tab, exact: true }).click()
    await expect(dialog.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false')
    expect(
      await page.evaluate(
        () =>
          document.querySelector('[role="alert"]') ===
          (window as unknown as { citationNotice: Element }).citationNotice
      )
    ).toBe(true)
  }
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(dialog.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false')
  expect(
    await page.evaluate(
      () => (window as unknown as { citationLoadingFlashes: number }).citationLoadingFlashes
    )
  ).toBe(0)
  await dialog.getByRole('button', { name: 'Configure API key', exact: true }).click()
  const input = dialog.getByLabel('API key', { exact: true })
  await expect(input).toBeFocused()
  await input.pressSequentially('test-key')
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(dialog.getByText('A follow-up study', { exact: true })).toBeVisible()
  await expect(input).not.toBeVisible()
})

for (const width of [320, 375, 414, 768, 1000]) {
  test(`citation loading transition at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.goto('/literature-recovery.html?mode=files&citation-loading')
    await page.getByText('All references', { exact: true }).click()
    await page
      .getByRole('button', { name: 'A reference with supporting PDFs', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await page.setViewportSize({ width, height: 850 })
    await dialog.getByRole('button', { name: 'References', exact: true }).click()
    await expect(
      dialog.getByText('An API key is optional but recommended.', { exact: true })
    ).toBeVisible()
    const loading = dialog.locator('[data-slot="citation-loading"]')
    await expect(loading.getByText('Searching…', { exact: true })).toBeVisible()
    const loadingBounds = await dialog.boundingBox()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await dialog.screenshot({ path: testInfo.outputPath('citation-loading.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(loading.locator('svg')).toHaveCSS('animation-name', 'none')
    await expect(loading.locator('div[aria-hidden="true"]')).toHaveCSS('animation-name', 'none')
    await page.evaluate(() =>
      (window as unknown as { finishCitationLookup(): void }).finishCitationLookup()
    )
    await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
    await expect(loading).not.toBeVisible()
    expect(await dialog.boundingBox()).toEqual(loadingBounds)
  })
}

test('suggests an optional citation key before any rate limit and hides it after saving', async ({
  page
}, testInfo) => {
  await page.goto('/literature-recovery.html?mode=files')
  await page.getByText('All references', { exact: true }).click()
  await page.getByRole('button', { name: 'A reference with supporting PDFs', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  const hint = dialog.locator('[data-slot="citation-key-hint"]')
  await expect(hint).toHaveText(/An API key is optional but recommended/)
  await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.screenshot({ path: testInfo.outputPath('citation-key-hint.png') })
  await hint.getByRole('button', { name: 'Configure API key', exact: true }).click()
  await expect(hint).not.toBeVisible()
  const input = dialog.getByLabel('API key', { exact: true })
  await expect(input).toBeFocused()
  await input.pressSequentially('test-key')
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(input).not.toBeVisible()
  await expect(hint).not.toBeVisible()
  await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Back', exact: true }).click()
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
  await expect(hint).not.toBeVisible()
})

test('can enter a citation key while the initial lookup is pending', async ({ page }) => {
  await page.goto('/literature-recovery.html?mode=files&citation-loading')
  await page.getByText('All references', { exact: true }).click()
  await page.getByRole('button', { name: 'A reference with supporting PDFs', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  await dialog.getByRole('button', { name: 'Configure API key', exact: true }).click()
  const input = dialog.getByLabel('API key', { exact: true })
  await expect(input).toBeFocused()
  await input.pressSequentially('test-key')
  await expect(dialog.getByRole('button', { name: 'Save key', exact: true })).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as { finishCitationLookup(): void }).finishCitationLookup()
  )
  await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Save key', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(input).not.toBeVisible()
  await expect(dialog.locator('[data-slot="citation-key-hint"]')).not.toBeVisible()
})
