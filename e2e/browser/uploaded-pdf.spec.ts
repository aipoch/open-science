import { expect, test } from '@playwright/test'

test('analyzes an uploaded PDF without Literature, message binding or note-write permission', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.goto('/uploaded-pdf.html')
  await expect(page.locator('[data-pdf-original-view] canvas')).toBeVisible()
  await page.getByRole('tab', { name: 'Figures & Tables' }).click()
  await expect(page.getByRole('button', { name: 'Analyze PDF', exact: true })).toBeEnabled()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { uploadedPdfAudit: { requests: unknown[] } }).uploadedPdfAudit
          .requests.length
    )
  ).toBe(0)
  await page.getByRole('button', { name: 'Analyze PDF', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Candidate table' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Notes & Annotations' })).toHaveCount(0)
  const requests = await page.evaluate(
    () =>
      (window as unknown as { uploadedPdfAudit: { requests: unknown[] } }).uploadedPdfAudit.requests
  )
  expect(requests).toEqual([
    {
      source: {
        kind: 'managed',
        projectId: 'project',
        sourceKind: 'upload-version',
        sourceFileId: 'file',
        sourceVersionId: 'version'
      },
      page: 1,
      requestId: expect.any(String)
    }
  ])
  await page.screenshot({ path: testInfo.outputPath('uploaded-pdf-tables.png') })
  await page.getByRole('button', { name: 'Show in PDF' }).first().click()
  await expect(page.getByRole('tab', { name: 'Original PDF' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('button', { name: 'Close preview' }).click()
  await page.getByRole('button', { name: 'Open preview' }).click()
  await page.getByRole('tab', { name: 'Figures & Tables' }).click()
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { uploadedPdfAudit: { requests: unknown[] } }).uploadedPdfAudit
          .requests.length
    )
  ).toBe(1)
  expect(errors).toEqual([])
})
