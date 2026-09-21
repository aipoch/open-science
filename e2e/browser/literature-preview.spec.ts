import { expect, test } from '@playwright/test'

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`attachment preview preserves its parent dialog with ${reducedMotion} motion`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ reducedMotion })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/modal-library-close.html?preview=1')
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    const title = page.getByRole('button', { name: 'Stable attachment preview', exact: true })
    await title.click()
    const detail = page.getByRole('dialog', { name: 'Stable attachment preview', exact: true })
    const trigger = detail.getByRole('button', { name: 'Preview paper.pdf', exact: true })
    await detail.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
      const scrim = element.previousElementSibling!
      const samples: boolean[] = []
      let active = true
      const sample = (): void => {
        samples.push(
          element.isConnected &&
            scrim.isConnected &&
            getComputedStyle(element).opacity === '1' &&
            getComputedStyle(scrim).opacity === '1'
        )
        if (active) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      Object.assign(window, {
        previewAudit: {
          samples,
          stop: () => {
            active = false
          }
        }
      })
    })

    for (const close of ['button', 'Escape']) {
      await trigger.click()
      const preview = page.getByRole('dialog', { name: 'Preview paper.pdf', exact: true })
      await expect(preview.locator('[data-page-number="1"] canvas')).toBeVisible()
      const scroller = preview.getByRole('region', { name: 'paper.pdf scrollable preview' })
      await scroller.click()
      await page.keyboard.press('Tab')
      expect(await preview.evaluate((element) => element.contains(document.activeElement))).toBe(
        true
      )
      await scroller.hover()
      await page.mouse.wheel(0, 300)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      // The preview owns the top scroll lock: its PDF scrolls while the background stays locked.
      await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')
      if (close === 'button') {
        await page.screenshot({ path: testInfo.outputPath('attachment-preview.png') })
        await preview.getByRole('button', { name: 'Close preview of paper.pdf' }).click()
      } else {
        await scroller.focus()
        await page.keyboard.press('Escape')
      }
      await expect(preview).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', '1')
    }
    const samples: boolean[] = await page.evaluate(() => {
      const audit = Reflect.get(window, 'previewAudit')
      audit.stop()
      return audit.samples
    })
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every(Boolean), 'parent panel and scrim stay opaque and mounted').toBe(true)
    await page.keyboard.press('Escape')
    await expect(detail).toHaveCount(0)
    await expect(title).toBeFocused()
    await expect(page.locator('body')).not.toHaveAttribute('data-scroll-locked')
    expect(errors).toEqual([])
  })
}

for (const entry of ['list', 'history', 'search'] as const) {
  test(`opens a scrollable PDF from ${entry} without remounting the parent`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const filename = entry === 'history' ? 'paper-v1.pdf' : 'paper.pdf'
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/modal-library-close.html?preview=${entry}`)
    if (entry !== 'search')
      await page.getByRole('button', { name: 'All references', exact: true }).click()
    if (entry === 'history') {
      await page.getByRole('button', { name: 'Stable attachment preview', exact: true }).click()
      await page.getByRole('button', { name: 'Attachment actions for paper.pdf' }).click()
      await page.getByRole('menuitem', { name: 'Version history' }).click()
    } else if (entry === 'search') {
      await page.getByRole('option').filter({ hasText: 'Stable attachment preview' }).click()
      await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    }
    const parent =
      entry === 'list'
        ? page.locator('main')
        : page.getByRole('dialog', {
            name: entry === 'search' ? 'Global search' : 'Stable attachment preview',
            exact: true,
            includeHidden: true
          })
    await parent.evaluate((element) => Object.assign(window, { previewParent: element }))
    if (entry === 'history')
      await page
        .getByRole('dialog', { name: 'Version history' })
        .getByRole('button', { name: `Preview ${filename}` })
        .click()
    else if (entry === 'search')
      await page.getByRole('button', { name: 'Open file', exact: true }).click()
    else await page.getByRole('button', { name: `Preview ${filename}` }).click()
    const preview = page.getByRole('dialog', { name: `Preview ${filename}`, exact: true })
    await expect(preview.locator('[data-page-number="1"] canvas')).toBeVisible()
    const scroller = preview.getByRole('region', { name: `${filename} scrollable preview` })
    await scroller.hover()
    await page.mouse.wheel(0, 300)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await preview.getByRole('button', { name: `Close preview of ${filename}` }).click()
    await expect(preview).toHaveCount(0)
    expect(
      await parent.evaluate((element) => element === Reflect.get(window, 'previewParent'))
    ).toBe(true)
    expect(errors).toEqual([])
  })
}

for (const area of [false, true]) {
  for (const direction of ['forward', 'backward'] as const) {
    for (const zoomed of [false, true]) {
      test(`PDF selection crosses ${area ? 'area removal' : 'annotations'} ${direction} at ${zoomed ? 'increased' : 'default'} zoom`, async ({
        page
      }) => {
        await page.setViewportSize({ width: 1280, height: 900 })
        await page.goto(`/modal-library-close.html?preview=${area ? 'area-selection' : '1'}`)
        // Mock only the native annotation boundary; render real PDF.js text and app overlays.
        await page.evaluate(() => {
          const source = {
            kind: 'literature-attachment-version' as const,
            sourceFileId: 'attachment-1',
            versionId: 'version-2',
            name: 'paper.pdf',
            path: 'literature-attachment-version:version-2',
            checksum: 'a'.repeat(64)
          }
          const annotation = {
            id: 'selection-note',
            literatureVersionId: 'version-2',
            version: 1,
            origin: 'user' as const,
            target: {
              source,
              selector: {
                kind: 'text' as const,
                pageNumber: 1,
                exact: 'A stable dialog',
                position: { start: 28, end: 43 },
                quads: [{ x: 50 / 612, y: 82 / 792, width: 85 / 612, height: 12 / 792 }],
                extractorVersion: 'fixture',
                pageRotation: 0,
                coordinateVersion: 1 as const
              }
            },
            kind: 'highlight' as const,
            color: 'yellow' as const,
            tagIds: [],
            note: 'Saved selection note',
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z'
          }
          window.api.pdfAnnotations = {
            list: async () => ({ source, items: [annotation], total: 1 }),
            onChanged: () => () => {}
          } as unknown as typeof window.api.pdfAnnotations
        })
        if (!area) {
          await page.getByRole('button', { name: 'All references', exact: true }).click()
          await page.getByRole('button', { name: 'Preview paper.pdf', exact: true }).click()
        }
        const marker = page.locator('[data-pdf-annotation-marker]')
        const highlight = page.locator('[data-pdf-bookmark-highlight="selection-note"]')
        const remove = page.getByRole('button', { name: 'Remove PDF area', exact: true })
        await expect(area ? remove : marker).toBeVisible()
        if (zoomed) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
        const lines = page.locator('.pdf-text-layer span')
        await expect(lines).toHaveCount(3)
        for (const target of area
          ? ['[data-pdf-area-remove]']
          : ['[data-pdf-annotation-marker]', '[data-pdf-bookmark-highlight]']) {
          const gesture = await page.evaluate(
            ({ direction, target }) => {
              const spans = [...document.querySelectorAll('.pdf-text-layer span')]
              const start = spans[direction === 'forward' ? 0 : 2].firstChild!
              const end = spans[1].firstChild!
              const overlay = document.querySelector(target)!.getBoundingClientRect()
              const character = (node: Node, offset: number): DOMRect => {
                const range = document.createRange()
                range.setStart(node, offset)
                range.setEnd(node, offset + 1)
                return range.getBoundingClientRect()
              }
              // End on an actual glyph underneath the overlay, away from caret rounding boundaries.
              let offset = 0
              for (; offset < end.textContent!.length; offset++) {
                const rect = character(end, offset)
                if (rect.left > overlay.left + 2 && rect.right < overlay.right - 2) break
              }
              if (offset === end.textContent!.length)
                throw new Error('No glyph underneath annotation')
              const first = character(start, 3)
              const last = character(end, offset)
              const range = document.createRange()
              range.setStart(
                direction === 'forward' ? start : end,
                direction === 'forward' ? 3 : offset
              )
              range.setEnd(
                direction === 'forward' ? end : start,
                direction === 'forward' ? offset : 3
              )
              return {
                from: { x: first.left + first.width * 0.1, y: first.top + first.height / 2 },
                to: { x: last.left + last.width * 0.1, y: last.top + last.height / 2 },
                expected: range.toString(),
                anchor: start.textContent,
                focus: end.textContent
              }
            },
            { direction, target }
          )
          await page.mouse.move(gesture.from.x, gesture.from.y)
          await page.mouse.down()
          await page.mouse.move(gesture.to.x, gesture.to.y, { steps: 8 })
          const selection = (): Promise<unknown> =>
            page.evaluate(() => ({
              // Selection includes visual line breaks; Range.toString() only joins text nodes.
              quote: getSelection()?.toString().replaceAll('\n', ''),
              anchor: getSelection()?.anchorNode?.textContent,
              focus: getSelection()?.focusNode?.textContent
            }))
          await expect
            .poll(selection)
            .toEqual({ quote: gesture.expected, anchor: gesture.anchor, focus: gesture.focus })
          await page.mouse.up()
          await expect
            .poll(selection)
            .toEqual({ quote: gesture.expected, anchor: gesture.anchor, focus: gesture.focus })
          // Releasing over a mark must not activate it as a click.
          if (area) await expect(remove).toBeVisible()
          else await expect(highlight).toHaveAttribute('aria-pressed', 'false')
          await expect(
            page.getByRole('dialog', { name: 'Annotation note', exact: true })
          ).toHaveCount(0)
          await page.keyboard.press('Escape')
        }
        // Pointer and keyboard access must recover immediately after the drag.
        if (area) {
          await remove.click()
          await expect(remove).toHaveCount(0)
          return
        }
        await marker.click()
        const note = page.getByRole('dialog', { name: 'Annotation note', exact: true })
        await expect(note).toContainText('Saved selection note')
        await page.keyboard.press('Escape')
        await highlight.click()
        await expect(highlight).toHaveAttribute('aria-pressed', 'true')
        await marker.focus()
        await page.keyboard.press('Enter')
        await expect(note).toContainText('Saved selection note')
      })
    }
  }
}
