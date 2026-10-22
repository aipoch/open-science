import { expect, test } from '@playwright/test'

for (const size of [
  { width: 1280, height: 800 },
  { width: 560, height: 420 },
  { width: 375, height: 640 }
]) {
  for (const dark of [false, true]) {
    for (const outcome of ['exported', 'partial', 'failed']) {
      test(`diagnostic ${outcome} stays visible at ${size.width}x${size.height} in ${dark ? 'dark' : 'light'}`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize(size)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto(
          `/session-diagnostics.html?outcome=${outcome}${dark ? '&dark&windows' : ''}`
        )
        const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
        const sources = dialog.getByTestId('diagnostics-sources')
        const feedback = dialog.getByTestId('diagnostics-feedback')
        const exportButton = dialog.getByRole('button', { name: 'Export', exact: true })
        await expect(exportButton).toBeEnabled()

        for (const atEnd of [false, true]) {
          await sources.evaluate((node, end) => {
            node.scrollTop = end ? node.scrollHeight : 0
          }, atEnd)
          await exportButton.click()
          await expect(feedback.getByRole('status')).toContainText(
            outcome === 'exported'
              ? 'Diagnostic package exported successfully.'
              : outcome === 'partial'
                ? 'Diagnostic package partially exported.'
                : 'Diagnostic export failed.'
          )
          await expect(feedback).toBeInViewport({ ratio: 1 })
          await expect(
            feedback.getByRole('button', { name: 'Copy report', exact: true })
          ).toBeInViewport({ ratio: 1 })
          await expect(exportButton).toBeInViewport({ ratio: 1 })
          if (outcome !== 'failed') {
            await expect(
              feedback.getByRole('button', { name: 'Show in folder', exact: true })
            ).toBeInViewport({ ratio: 1 })
            const path = feedback.locator('code')
            await expect(path).toContainText('diagnostics.tar.gz')
            await path.focus()
            await expect(path).toBeFocused()
            await expect(path).toBeInViewport({ ratio: 1 })
          } else {
            await expect(feedback.getByRole('alert')).toContainText(
              'Diagnostic operation timed out.'
            )
          }
          const metrics = await dialog.evaluate((node) => {
            const sources = node.querySelector('[data-testid="diagnostics-sources"]')!
            const feedback = node.querySelector('[data-testid="diagnostics-feedback"]')!
            return {
              top: node.getBoundingClientRect().top,
              bottom: node.getBoundingClientRect().bottom,
              viewportHeight: innerHeight,
              titlebarHeight:
                parseFloat(
                  getComputedStyle(document.documentElement).getPropertyValue(
                    '--windows-titlebar-height'
                  )
                ) || 0,
              overflowX: node.scrollWidth - node.clientWidth,
              overflowY: node.scrollHeight - node.clientHeight,
              feedbackBottom: feedback.getBoundingClientRect().bottom,
              sourcesTop: sources.getBoundingClientRect().top,
              sourcesHeight: sources.clientHeight,
              sourceScrollTop: sources.scrollTop
            }
          })
          expect(metrics.top).toBeGreaterThanOrEqual(metrics.titlebarHeight + 15)
          expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight - 15)
          expect(metrics.overflowX).toBeLessThanOrEqual(1)
          expect(metrics.overflowY).toBeLessThanOrEqual(1)
          expect(metrics.feedbackBottom).toBeLessThanOrEqual(metrics.sourcesTop)
          expect(metrics.sourcesHeight).toBeGreaterThan(40)
          if (atEnd) expect(metrics.sourceScrollTop).toBeGreaterThan(0)
          else expect(metrics.sourceScrollTop).toBe(0)
        }
        await page.screenshot({ path: testInfo.outputPath('diagnostic-feedback.png') })
      })
    }
  }
}

test('preparation feedback stays above the checklist', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 })
  await page.goto('/session-diagnostics.html?preparing')
  const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
  await expect(dialog.getByRole('status')).toHaveText('Preparing diagnostics…')
  await expect(dialog.getByTestId('diagnostics-feedback')).toBeInViewport({ ratio: 1 })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport({
    ratio: 1
  })
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
})

test('Windows fullscreen uses the full content safe area', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 420 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/session-diagnostics.html?windows&fullscreen')
  const dialog = page.getByRole('dialog', { name: 'Export diagnostics', exact: true })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(dialog.getByTestId('diagnostics-feedback')).toBeInViewport({ ratio: 1 })
  const bounds = await dialog.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(15)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(405)
  expect(bounds!.height).toBeGreaterThan(352)
})
