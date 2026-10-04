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
  // Completed and restored results keep retry controls behind an explicit disclosure.
  await expect(page.locator('[data-pdf-figures-content] > header')).toHaveCount(0)
  for (const width of [1100, 420]) {
    await page.setViewportSize({ width, height: 850 })
    const options = page.getByRole('button', { name: 'PDF analysis options', exact: true })
    await expect(options).toBeVisible()
    await expect(page.getByRole('button', { name: 'Analyze again', exact: true })).toHaveCount(0)
    await options.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('combobox', { name: 'Parallel pages' }).click()
    await page.getByRole('option', { name: '4x', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'PDF analysis options' })).toBeVisible()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { uploadedPdfAudit: { requests: unknown[] } }).uploadedPdfAudit
            .requests.length
      )
    ).toBe(1)
    await page.keyboard.press('Escape')
    await expect(options).toBeFocused()
  }
  await page.getByRole('button', { name: 'PDF analysis options', exact: true }).click()
  await page.getByRole('button', { name: 'Analyze again', exact: true }).click()
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { uploadedPdfAudit: { requests: unknown[] } }).uploadedPdfAudit
          .requests.length
    )
  ).toBe(2)
  expect(errors).toEqual([])
})

test('PDF navigation explains missing outlines and floats without shrinking narrow readers', async ({
  page
}) => {
  await page.setViewportSize({ width: 1150, height: 850 })
  await page.goto('/uploaded-pdf.html?navigation')
  const navigation = page.getByRole('complementary', { name: 'PDF navigation' })
  const scroller = page.locator('[data-pdf-cursor-mode]')
  await page.getByRole('button', { name: 'Show navigation' }).click()
  await expect(navigation).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize navigation' })).toBeVisible()
  const outline = page.getByRole('button', { name: 'Outline', exact: true })
  await expect(outline).toHaveAttribute('aria-disabled', 'true')
  await outline.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'No readable outline is available for this PDF'
  )
  await page.mouse.click(
    ...(await outline.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return [rect.x + rect.width / 2, rect.y + rect.height / 2] as [number, number]
    }))
  )
  await expect(page.getByRole('button', { name: 'Pages', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.setViewportSize({ width: 800, height: 850 })
  await expect(page.getByRole('separator', { name: 'Resize navigation' })).toHaveCount(0)
  await expect.poll(() => scroller.evaluate((el) => el.getBoundingClientRect().width)).toBe(800)
  await expect(navigation).toHaveCSS('position', 'absolute')
  await page.getByRole('button', { name: 'Page 2', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Page 2', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await page.keyboard.press('Escape')
  await expect(navigation).toHaveCount(0)
  await expect(scroller).toBeFocused()
  await page.getByRole('button', { name: 'Show navigation' }).click()
  await page.setViewportSize({ width: 1150, height: 850 })
  await expect(page.getByRole('separator', { name: 'Resize navigation' })).toBeVisible()
  await expect(navigation).toHaveCSS('position', 'relative')
  await expect.poll(() => scroller.evaluate((el) => el.getBoundingClientRect().width)).toBe(910)
})

test('keeps analysis options visible for a cached singleton figure on desktop', async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.goto('/uploaded-pdf.html')
  await page.getByRole('tab', { name: 'Figures & Tables' }).click()
  await page.getByRole('button', { name: 'Analyze PDF', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Candidate table' })).toBeVisible()
  await page.getByRole('button', { name: 'Close preview' }).click()
  // Restore one image-only result: no table switcher or continuation-page heading.
  await page.evaluate(() => {
    const readCached = window.api.pdfStructure.readCached
    window.api.pdfStructure.readCached = async (request) => {
      const result = await readCached(request)
      return (
        result && {
          ...result,
          elements: result.elements.map((element) => ({
            ...element,
            kind: 'figure',
            table: undefined
          }))
        }
      )
    }
  })
  await page.getByRole('button', { name: 'Open preview' }).click()
  await page.getByRole('tab', { name: 'Figures & Tables' }).click()
  await expect(page.getByRole('group', { name: 'Table preview' })).toHaveCount(0)
  await expect(page.locator('[data-pdf-figure-detail] article')).toHaveCount(1)
  const options = page.getByRole('button', { name: 'PDF analysis options', exact: true })
  await expect(options).toBeVisible()
  await options.click()
  await expect(page.getByRole('combobox', { name: 'Parallel pages' })).toBeVisible()
  await page.getByRole('button', { name: 'Analyze again', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Candidate table' })).toBeVisible()
})
