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

for (const width of [375, 1000]) {
  test(`single-paper citation discovery at ${width}px`, async ({ page }) => {
    // Open the existing desktop table before exercising the detail at narrow widths.
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.goto('/literature-recovery.html?mode=files')
    await page.getByText('All references', { exact: true }).click()
    await page.getByText('A reference with supporting PDFs', { exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.setViewportSize({ width, height: 850 })
    await dialog.getByRole('button', { name: 'References', exact: true }).click()
    await expect(dialog.getByText('A foundational reference', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cited by', exact: true }).click()
    await expect(dialog.getByText('A follow-up study', { exact: true })).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Select A follow-up study' }).check()
    await dialog.getByRole('button', { name: 'Add selected to Inbox' }).click()
    await expect(dialog.getByText('In Inbox', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'References', exact: true })).toBeFocused()
    await expect(
      dialog.getByText('A reference with supporting PDFs', { exact: true })
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
