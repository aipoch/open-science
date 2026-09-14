import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Rotated PDF bookmarks'
const PDF_NAME = 'rotated-bookmarks.pdf'

const rotatedPdf = (multiline = false): Buffer => {
  const stream = (content: string): string =>
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  const page90 = multiline
    ? 'BT /F1 18 Tf 72 650 Td (Rotation ninety evidence) Tj 0 -28 Td (Continued on the second line) Tj ET'
    : 'BT /F1 18 Tf 72 650 Td (Rotation ninety evidence) Tj ET'
  const page270 = 'BT /F1 18 Tf 72 650 Td (Rotation two seventy region) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${multiline ? 0 : 90} /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 270 /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(page90),
    stream(page270)
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

const createProjectAndSession = async (page: Page, multiline = false): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: PDF_NAME,
    mimeType: 'application/pdf',
    buffer: rotatedPdf(multiline)
  })
  await page
    .getByRole('textbox', { name: 'Ask anything' })
    .fill('Summarize the deterministic fixture.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
}

const openUploadedPdf = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('button', { name: `Preview uploaded file ${PDF_NAME}` }).click()
  const preview = page.getByRole('dialog', { name: `Preview ${PDF_NAME}` })
  await expect(
    preview.getByRole('region', { name: `${PDF_NAME} scrollable preview` })
  ).toBeVisible()
  await expect(preview.locator('[data-page-number="1"] [data-pdf-text-layer]')).toContainText(
    'Rotation ninety evidence'
  )
  return preview
}

type NormalizedRect = { x: number; y: number; width: number; height: number }

const expectNormalizedRect = async (
  pageSurface: Locator,
  marker: Locator,
  expected: NormalizedRect
): Promise<void> => {
  const pageBox = await pageSurface.boundingBox()
  const markerBox = await marker.boundingBox()
  expect(pageBox).not.toBeNull()
  expect(markerBox).not.toBeNull()
  const actual = {
    x: (markerBox!.x - pageBox!.x) / pageBox!.width,
    y: (markerBox!.y - pageBox!.y) / pageBox!.height,
    width: markerBox!.width / pageBox!.width,
    height: markerBox!.height / pageBox!.height
  }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(0.015)
  }
}

test('restores text and region bookmarks on intrinsically rotated PDF pages', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProjectAndSession(page)
  const preview = await openUploadedPdf(page)

  const page90 = preview.locator('[data-page-number="1"]')
  await expect(page90).toHaveAttribute('data-pdf-page-rotation', '90')
  const rotatedText = page90
    .locator('[data-pdf-text-layer] span')
    .filter({ hasText: 'Rotation ninety evidence' })
  await rotatedText.dblclick()
  const selection = await page90.evaluate((element) => {
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null
    const selectionRect = range?.getBoundingClientRect()
    const pageRect = element.getBoundingClientRect()
    return {
      text: window.getSelection()?.toString().trim() ?? '',
      normalizedRect:
        selectionRect && pageRect.width > 0 && pageRect.height > 0
          ? {
              x: (selectionRect.left - pageRect.left) / pageRect.width,
              y: (selectionRect.top - pageRect.top) / pageRect.height,
              width: selectionRect.width / pageRect.width,
              height: selectionRect.height / pageRect.height
            }
          : undefined,
      insidePage: Boolean(
        selectionRect &&
        selectionRect.width > 0 &&
        selectionRect.height > 0 &&
        selectionRect.left >= pageRect.left &&
        selectionRect.right <= pageRect.right &&
        selectionRect.top >= pageRect.top &&
        selectionRect.bottom <= pageRect.bottom
      )
    }
  })
  expect(selection.text).not.toBe('')
  expect(selection.insidePage).toBe(true)
  expect(selection.normalizedRect).toBeDefined()
  expect(selection.normalizedRect!.x).toBeGreaterThan(0.78)
  expect(selection.normalizedRect!.x).toBeLessThan(0.86)
  expect(selection.normalizedRect!.height).toBeGreaterThan(selection.normalizedRect!.width)
  await page.locator('[data-selection-action="bookmark"]').click()
  await expect(page.getByRole('textbox', { name: 'Note (optional)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click()
  const textMarker = page90.locator('[data-pdf-bookmark-highlight]')
  await expect(textMarker).toBeVisible()
  await expectNormalizedRect(page90, textMarker, selection.normalizedRect!)

  await preview.getByRole('button', { name: 'Area' }).click()
  const page270 = preview.locator('[data-page-number="2"]')
  await page270.scrollIntoViewIfNeeded()
  await expect(page270).toHaveAttribute('data-pdf-page-rotation', '270')
  const region = page270.locator('[data-pdf-region-selection="true"]')
  await expect(region).toBeVisible()
  const bounds = await region.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * 0.2, bounds!.y + bounds!.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width * 0.6, bounds!.y + bounds!.height * 0.5)
  await page.mouse.up()
  const regionEditor = page.locator('[data-pdf-region-bookmark-editor="true"]')
  await expect(regionEditor).toBeVisible()
  await regionEditor.getByRole('tab', { name: 'For me' }).click()
  await regionEditor.getByRole('button', { name: 'Bookmark', exact: true }).click()
  const regionMarker = page270.locator('[data-pdf-bookmark-highlight]')
  await expect(regionMarker).toBeVisible()
  const regionRect = { x: 0.2, y: 0.2, width: 0.4, height: 0.3 }
  await expectNormalizedRect(page270, regionMarker, regionRect)

  await preview.getByRole('button', { name: `Close preview of ${PDF_NAME}` }).click()
  await expect(page.getByRole('button', { name: 'Bookmarks (2)' })).toBeVisible()

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: /Summarize the deterministic fixture/u })
    .click()
  await page.getByRole('button', { name: 'Bookmarks (2)' }).click()
  const bookmarks = page.getByRole('region', { name: 'Bookmarks' })
  const textRevealButton = bookmarks
    .getByRole('listitem')
    .filter({ hasText: selection.text })
    .getByRole('button', { name: 'Show bookmark source' })
  await textRevealButton.click()
  const restoredPage90 = page.locator('[data-page-number="1"]')
  const restoredTextMarker = restoredPage90.locator('[data-pdf-bookmark-highlight]')
  await expect(restoredTextMarker).toBeInViewport()
  await expect(textRevealButton).toBeEnabled()
  await expect(bookmarks.getByRole('alert')).toHaveCount(0)
  await expectNormalizedRect(restoredPage90, restoredTextMarker, selection.normalizedRect!)
  const screenshotPath = testInfo.outputPath('bookmarks-pdf-restored.png')
  await page.screenshot({ path: screenshotPath })
  await testInfo.attach('rotated-pdf-restored', {
    path: screenshotPath,
    contentType: 'image/png'
  })

  // At fit width both landscape pages can fit in a tall window. Zoom in before testing
  // navigation so the second-page marker starts outside the visible reading area.
  const viewControls = page.getByRole('group', { name: 'PDF view controls' })
  for (let step = 0; step < 4; step += 1) {
    await viewControls.getByRole('button', { name: 'Zoom in', exact: true }).click()
  }
  await expect(viewControls).toContainText('200%')
  await restoredTextMarker.scrollIntoViewIfNeeded()
  await expect(bookmarks).not.toBeVisible()
  await page.getByRole('button', { name: 'Bookmarks (2)' }).click()

  const regionRevealButton = bookmarks
    .getByRole('listitem')
    .filter({ hasText: 'PDF region on page 2' })
    .getByRole('button', { name: 'Show bookmark source' })
  // Start from the other page so a successful reveal must move the reading position.
  await expect(
    page.locator('[data-page-number="2"] [data-pdf-bookmark-highlight]')
  ).not.toBeInViewport()
  await regionRevealButton.click()
  const restoredPage270 = page.locator('[data-page-number="2"]')
  const restoredRegionMarker = restoredPage270.locator('[data-pdf-bookmark-highlight]')
  await expect(restoredRegionMarker).toBeInViewport()
  await expect(regionRevealButton).toBeEnabled()
  await expect(bookmarks.getByRole('alert')).toHaveCount(0)
  await expectNormalizedRect(restoredPage270, restoredRegionMarker, regionRect)
})

test('keeps the PDF bookmark editor open after a native multiline selection', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectAndSession(page, true)
  const preview = await openUploadedPdf(page)
  const pdfPage = preview.locator('[data-page-number="1"]')
  const first = await pdfPage
    .locator('[data-pdf-text-layer] span')
    .filter({ hasText: 'Rotation ninety evidence' })
    .boundingBox()
  const last = await pdfPage
    .locator('[data-pdf-text-layer] span')
    .filter({ hasText: 'Continued on the second line' })
    .boundingBox()
  expect(first).not.toBeNull()
  expect(last).not.toBeNull()
  await page.mouse.move(first!.x + 2, first!.y + first!.height / 2)
  await page.mouse.down()
  await page.mouse.move(last!.x + last!.width - 2, last!.y + last!.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.locator('[data-selection-action="bookmark"]').click()
  const note = page.getByRole('textbox', { name: 'Note (optional)', exact: true })
  await expect(note).toBeVisible()
  await expect(page.getByRole('tab', { name: 'To Agent', exact: true })).toHaveCount(0)
  await expect(page.getByPlaceholder('Add context for the Agent')).toHaveCount(0)
  await note.fill('Cross-line evidence')
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click()
  await expect(pdfPage.locator('[data-pdf-bookmark-highlight]')).toHaveCount(2)
})
