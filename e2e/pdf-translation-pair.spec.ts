import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from '@playwright/test'
import {
  PDFDocument,
  PDFDict,
  PDFName,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  rgb
} from 'pdf-lib'
import { literatureItemInputSchema } from '../src/shared/literature'
import { test } from './fixtures/electron-app'

const openReadingView = async (page: Page): Promise<void> => {
  const trigger = page.getByRole('button', { name: 'Reading view', exact: true })
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
}
const selectRendition = async (page: Page, name: string): Promise<void> => {
  await openReadingView(page)
  await page
    .getByRole('group', { name: 'PDF rendition' })
    .getByRole('button', { name, exact: true })
    .click()
}

const directServers = new Set<Server>()
test.afterEach(async () => {
  for (const server of directServers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  directServers.clear()
})

// Actual application/IPC/WASM/renderer, synthetic document and controlled agent/API output.
// This verifies reader integration, not translation-model quality.
for (const variant of [
  'agent-model',
  'standard',
  'direct-api',
  'provider-overloaded',
  'close-confirmation',
  'streaming-reading',
  'retained-paragraph',
  'recovery',
  'cropped',
  'rotated',
  'annotated',
  'links',
  'inline-link',
  'multiline-link',
  'reflow-link',
  'busy'
]) {
  const hasInlineLinks = ['inline-link', 'multiline-link', 'reflow-link'].includes(variant)
  test(`handles ${variant} PDF generation and synchronized reading`, async ({ app }, testInfo) => {
    test.setTimeout(180000)
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    const settingsBefore = await page.evaluate(() => window.api.settings.getSettings())
    let agentProviderId: string | undefined
    if (variant === 'agent-model') {
      agentProviderId = await page.evaluate(async () => {
        const snapshot = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Translation Agent test',
          model: 'e2e-model',
          key: 'e2e-key',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiEndpoints: ['openai']
        })
        return snapshot.providers.find((entry) => entry.name === 'Translation Agent test')!.id
      })
    }
    const directRequests: Array<Record<string, unknown>> = []
    let paragraphRequests = 0
    let directProvider: { id: string; baseUrl: string } | undefined
    let replacementText: string | undefined
    let holdTranslation = ['close-confirmation', 'streaming-reading'].includes(variant)
    const heldTranslations: Array<() => void> = []
    if (
      [
        'direct-api',
        'provider-overloaded',
        'close-confirmation',
        'streaming-reading',
        'retained-paragraph'
      ].includes(variant)
    ) {
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        let body = ''
        for await (const chunk of request) body += chunk
        const payload = JSON.parse(body)
        directRequests.push(payload)
        // This plain-text provider exercises fallback from unsupported batch output.
        // Only individual translations drive the pause/overload scenarios.
        const isBatch = Array.isArray(JSON.parse(payload.messages[1].content).units)
        if (!isBatch) paragraphRequests += 1
        if (variant === 'provider-overloaded' && !isBatch && paragraphRequests === 2) {
          response.writeHead(529, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              error: {
                type: 'overloaded_error',
                message: 'Synthetic provider is busy',
                api_key: 'synthetic-private-key'
              }
            })
          )
          return
        }
        if (holdTranslation && !isBatch && paragraphRequests > 1) {
          await new Promise<void>((resolve) => heldTranslations.push(resolve))
        }
        // Controlled latency makes the actual running state observable.
        await new Promise((resolve) => setTimeout(resolve, 250))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            usage: {
              prompt_tokens: 100,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 20 }
            },
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content:
                    replacementText ??
                    '<think>PRIVATE_TRANSLATION_REASONING: translate the source faithfully.</think>测量受控实验室培养物中的细胞生长。',
                  reasoning_content: 'PRIVATE_SEPARATE_REASONING'
                }
              }
            ]
          })
        )
      })
      directServers.add(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing direct API test address')
      const configured = await page.evaluate(async (port) => {
        const snapshot = await window.api.settings.upsertProvider({
          type: 'custom',
          name: 'Local direct translation test',
          model: 'translation-test',
          apiEndpoints: ['openai'],
          baseUrl: `http://127.0.0.1:${port}`
        })
        const provider = snapshot.providers.find(
          (value) => value.name === 'Local direct translation test'
        )!
        return { providerId: provider.id, activeProviderId: snapshot.activeProviderId }
      }, address.port)
      expect(configured.activeProviderId).not.toBe(configured.providerId)
      directProvider = { id: configured.providerId, baseUrl: `http://127.0.0.1:${address.port}` }
    }
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      citationFont = await pdf.embedFont(StandardFonts.TimesRoman)
    for (let i = 0; i < 4; i++) {
      const sheet = pdf.addPage([612, 792])
      if (['cropped', 'rotated'].includes(variant) && i === 0) sheet.setCropBox(20, 30, 570, 730)
      if (['annotated', 'links'].includes(variant) && i === 0)
        sheet.node.set(
          PDFName.of('Annots'),
          pdf.context.obj([
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot',
                Subtype: variant === 'links' ? 'Link' : 'Text',
                Rect: variant === 'links' ? [20, 680, 600, 750] : [40, 700, 500, 730],
                ...(variant === 'links' ? { Dest: [sheet.ref, 'Fit'] } : {})
              })
            )
          ])
        )
      if (variant === 'retained-paragraph' && i === 0) {
        sheet.node.set(
          PDFName.of('Annots'),
          pdf.context.obj([
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [40, 707, 65, 727],
                Dest: [sheet.ref, 'Fit']
              })
            )
          ])
        )
      }
      if (variant === 'rotated' && i === 0) {
        sheet.setRotation(degrees(90))
        // Landscape crop with counter-rotated text/graphics: upright in the reader,
        // quarter-turn object matrices in PDF user space.
        sheet.pushOperators(concatTransformationMatrix(0, 1, -1, 0, 812, 30))
      }
      const proseX = hasInlineLinks ? 44 + citationFont.widthOfTextAtSize('Methods: ', 16) : 40
      if (hasInlineLinks)
        sheet.drawText('Methods: ', { font: citationFont, x: 40, y: 710, size: 16 })
      const firstLine =
        variant === 'reflow-link'
          ? 'Cell'
          : variant === 'multiline-link'
            ? 'Cell growth is measured in controlled'
            : 'Cell growth is measured in controlled laboratory cultures.'
      sheet.drawText(firstLine, {
        font,
        x: proseX,
        y: 710,
        size: 16
      })
      // Page 2 takes two responses: its first response must keep page 1 readable
      // and can be included by an explicit refresh before page 2 is complete.
      if (variant === 'streaming-reading' && i === 1)
        sheet.drawText(firstLine, { font, x: proseX, y: 590, size: 16 })
      if (variant === 'multiline-link')
        sheet.drawText('laboratory cultures.', { font, x: 40, y: 686, size: 16 })
      if (hasInlineLinks) {
        const linkY = variant === 'multiline-link' ? 686 : 710
        const x =
            (variant === 'multiline-link' ? 40 : proseX) +
            4 +
            font.widthOfTextAtSize(
              variant === 'multiline-link' ? 'laboratory cultures.' : firstLine,
              16
            ),
          width = citationFont.widthOfTextAtSize('[1]', 16)
        for (const [index, label] of ['[1]', '[2]'].entries())
          sheet.drawText(label, {
            font: citationFont,
            x: x + index * (width + 2),
            y: linkY,
            size: 16
          })
        if (variant === 'reflow-link') {
          sheet.drawText(' growth is measured in controlled', {
            font,
            x: x + 2 * (width + 2),
            y: linkY,
            size: 16
          })
          sheet.drawText('laboratory cultures.', { font, x: 40, y: 686, size: 16 })
        }
        sheet.node.set(
          PDFName.of('Annots'),
          pdf.context.obj(
            [0, 1].map((index) =>
              pdf.context.register(
                pdf.context.obj({
                  Type: 'Annot',
                  Subtype: 'Link',
                  Rect: [
                    x + index * (width + 2) - 0.5,
                    linkY - 4,
                    x +
                      index * (width + 2) +
                      (index === 1 && variant !== 'reflow-link' ? width / 2 : width + 0.5),
                    linkY + 14
                  ],
                  Border: [0, 0, 0],
                  Dest: [sheet.ref, 'Fit']
                })
              )
            )
          )
        )
      }
      sheet.drawLine({
        start: { x: 70, y: 340 },
        end: { x: 550, y: 340 },
        thickness: 1,
        color: rgb(0.4, 0.4, 0.4)
      })
      for (let bar = 0; bar < 5; bar++)
        sheet.drawRectangle({
          x: 90 + bar * 90,
          y: 340,
          width: 45,
          height: 70 + bar * 35,
          color: rgb(0.2, 0.45 + bar * 0.04, 0.43),
          borderWidth: 0
        })
    }
    for (const [index, sheet] of pdf.getPages().entries()) {
      if (['cropped', 'rotated'].includes(variant) && index === 0)
        sheet.node.set(
          PDFName.of('Annots'),
          pdf.context.obj([
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [220, 120, 280, 145],
                Border: [0, 0, 0],
                Dest: [pdf.getPage(1).ref, 'Fit']
              })
            )
          ])
        )
      if (hasInlineLinks || (variant === 'links' && index === 0))
        for (let link = 0; link < (sheet.node.Annots()?.size() ?? 0); link++)
          sheet.node
            .Annots()
            ?.lookup(link, PDFDict)
            .set(
              PDFName.of('Dest'),
              pdf.context.obj(
                hasInlineLinks
                  ? [pdf.getPage((index + 1) % 4).ref, 'XYZ', 40, 452, 4]
                  : [pdf.getPage((index + 1) % 4).ref, 'Fit']
              )
            )
    }
    const bytes = [...(await pdf.save())]
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: `${variant} PDF acceptance — synthetic document`
    })
    const fixtureVersionId = await page.evaluate(
      async ({ item, bytes }) => {
        const created = await window.api.literature.transact({ kind: 'create-item', item })
        const transferId = crypto.randomUUID(),
          chunk = new Uint8Array(bytes)
        await window.api.uploads.beginTransfer({
          transferId,
          name: 'paired-reading.pdf',
          mimeType: 'application/pdf',
          size: chunk.length
        })
        await window.api.uploads.appendTransfer({ transferId, offset: 0, chunk })
        const attachment = await window.api.uploads.finishTransfer({ transferId })
        const imported = await window.api.literature.importPdf({ itemId: created.id, attachment })
        return imported.item.attachments.flatMap((entry) => entry.versions)[0].id
      },
      { item, bytes }
    )
    await page.getByRole('button', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    await page.getByRole('button', { name: 'Preview paired-reading.pdf', exact: true }).click()
    await page.getByRole('button', { name: 'Full-text translation', exact: true }).click()
    await page.getByRole('button', { name: 'Prepare full text', exact: true }).click()
    const panel = page.locator('[data-pdf-translation-sidebar]')
    await expect(panel).toContainText('Full text prepared')
    await panel.getByRole('combobox', { name: 'Translation method' }).click()
    await page
      .getByRole('option', {
        name: [
          'direct-api',
          'provider-overloaded',
          'close-confirmation',
          'streaming-reading',
          'retained-paragraph'
        ].includes(variant)
          ? 'Direct API'
          : 'Agent',
        exact: true
      })
      .click()
    if (
      [
        'direct-api',
        'provider-overloaded',
        'close-confirmation',
        'streaming-reading',
        'retained-paragraph'
      ].includes(variant)
    ) {
      await panel.getByRole('combobox', { name: 'Model', exact: true }).click()
      await page
        .getByRole('option', {
          name: 'translation-test · Local direct translation test',
          exact: true
        })
        .click()
    }
    if (variant === 'direct-api') {
      const guidance = 'Direct API only supports API models. Subscription models must use Agent.'
      await expect(panel.getByText(guidance, { exact: true })).toHaveCount(0)
      await panel.getByRole('button', { name: 'Model settings', exact: true }).hover()
      await expect(page.getByRole('tooltip')).toHaveText(guidance)
      await page.mouse.move(0, 0, { steps: 5 })
      await expect(page.getByRole('tooltip')).toBeHidden()
      const changeModel = (model: string): Promise<unknown> =>
        page.evaluate(
          ({ provider, model }) =>
            window.api.settings.upsertProvider({
              ...provider,
              type: 'custom',
              name: 'Local direct translation test',
              apiEndpoints: ['openai'],
              model
            }),
          { provider: directProvider!, model }
        )
      await changeModel('replacement-model')
      await panel.getByRole('combobox', { name: 'Model', exact: true }).click()
      const unavailable = page.getByRole('option', { name: 'translation-test · Unavailable' })
      await expect(unavailable).toBeDisabled()
      await unavailable.hover()
      await expect(page.getByRole('tooltip')).toHaveText(
        'The selected model is no longer available. Select another model or check its configuration in Settings.'
      )
      await page.screenshot({ path: testInfo.outputPath('unavailable-model-hint.png') })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tooltip')).toBeHidden()
      await expect(panel).toBeVisible()
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox')).toBeHidden()
      await expect(panel).toBeVisible()
      await changeModel('translation-test')
    }
    if (variant === 'agent-model') {
      await panel.getByRole('combobox', { name: 'Model', exact: true }).click()
      await page
        .getByRole('option', { name: 'e2e-model · Translation Agent test', exact: true })
        .click()
      await page.screenshot({ path: testInfo.outputPath('agent-model-selection.png') })
    }
    await panel.getByLabel('Target language', { exact: true }).fill('Chinese')
    await panel.getByRole('button', { name: 'Translation glossary', exact: true }).click()
    await panel.getByRole('button', { name: 'Add term', exact: true }).click()
    await panel.getByLabel('Source term 1', { exact: true }).fill('PAIR_PDF_ACCEPTANCE')
    await panel
      .getByLabel('Preferred translation 1', { exact: true })
      .fill('controlled test fixture')
    if (hasInlineLinks) {
      await panel.getByRole('button', { name: 'Add term', exact: true }).click()
      await panel.getByLabel('Source term 2', { exact: true }).fill('PAIR_PDF_INLINE_LINK')
      await panel.getByLabel('Preferred translation 2', { exact: true }).fill('retain citation')
    }
    const originalCanvas = page.locator('[data-page-number="1"] canvas').first()
    let originalPixels: string | undefined
    if (variant === 'streaming-reading') {
      await expect(
        page.locator('[data-page-number="1"] [data-pdf-page-ready="true"]')
      ).toBeVisible()
      originalPixels = await originalCanvas.evaluate((node: HTMLCanvasElement) => {
        node.dataset.stableOriginal = 'true'
        return node.toDataURL()
      })
    }
    await panel.getByRole('button', { name: 'Translate document', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('translating.png') })
    await expect(page.locator('[data-pdf-translated-page]')).toHaveCount(0)
    if (variant === 'provider-overloaded') {
      await expect(panel.getByText('Translation paused', { exact: true })).toBeVisible()
      await expect(panel.getByRole('alert')).toHaveCount(0)
      await expect(panel).toContainText('1 / 4')
      expect(paragraphRequests).toBe(2)
      const details = panel
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: 'Details' }) })
      await expect(details).not.toHaveAttribute('open')
      await details.locator('summary').click()
      await expect(details).toContainText('HTTP 529')
      await expect(details).toContainText('Synthetic provider is busy')
      await expect(details).not.toContainText('synthetic-private-key')
      await details.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('provider-error-details.png') })
      await panel.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(panel.getByRole('button', { name: '4 Translated', exact: true })).toBeVisible()
      expect(paragraphRequests).toBe(5)
      await expect(panel.getByText('Translation paused', { exact: true })).toBeHidden()
      await expect(details).toHaveCount(0)
      return
    }
    if (variant === 'streaming-reading') {
      await expect(panel).toContainText('1 / 5')
      await openReadingView(page)
      await expect(
        page
          .getByRole('group', { name: 'PDF rendition' })
          .getByRole('button', { name: 'Translation', exact: true })
      ).toBeEnabled({ timeout: 60000 })
      await expect(originalCanvas).toHaveAttribute('data-stable-original', 'true')
      expect(await originalCanvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(
        originalPixels
      )
      await selectRendition(page, 'Translation')
      await expect(
        page.locator('[data-pdf-translated-page]').first().locator('canvas')
      ).toBeVisible()
      await selectRendition(page, 'Compare')
      const canvas = page.locator('[data-pdf-translated-page]').first().locator('canvas')
      await expect(canvas).toBeVisible()
      await expect(
        page.locator('[data-pdf-translated-page]').first().locator('[data-pdf-page-ready="true"]')
      ).toBeVisible()
      let pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
        node.dataset.stableTranslation = 'true'
        return node.toDataURL()
      })
      // Resuming must preserve the verified canvas and the reader's disclosure choice,
      // including intermediate renders before IPC admission and the next model response.
      const reviewToggle = panel.getByRole('button', { name: /^Translation\s+1$/ })
      for (const expanded of [false, true]) {
        await expect.poll(() => heldTranslations.length).toBeGreaterThan(0)
        await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(panel.getByRole('button', { name: 'Continue translation' })).toBeVisible()
        heldTranslations.shift()!()
        if ((await reviewToggle.getAttribute('aria-pressed')) !== String(expanded))
          await reviewToggle.click()
        // Take the baseline after switching modes and settling the disclosure layout.
        pixels = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())
        const observer = await page.evaluateHandle(
          ({ expanded }) => {
            const canvas = document.querySelector('[data-stable-translation="true"]')!
            const sidebar = document.querySelector('[data-pdf-translation-sidebar]')!
            const review = [...sidebar.querySelectorAll('button')].find((button) =>
              /^Translation\s*1$/.test(button.textContent?.trim() ?? '')
            )!
            const violations: string[] = []
            const observer = new MutationObserver((records) => {
              if (!canvas.isConnected) violations.push('canvas replaced')
              if (!review.isConnected) violations.push('translation list remounted')
              if (review.getAttribute('aria-pressed') !== String(expanded))
                violations.push('translation list toggled')
              if (
                records.some(
                  (record) => record.target === review && record.attributeName === 'aria-pressed'
                )
              )
                violations.push('translation list briefly toggled')
              if (
                /Preparing translated PDF|Checking translated PDF/.test(sidebar.textContent ?? '')
              )
                violations.push('PDF generation restarted')
            })
            observer.observe(sidebar, { subtree: true, childList: true, attributes: true })
            observer.observe(canvas.parentElement!, { subtree: true, childList: true })
            return { violations, stop: () => observer.disconnect() }
          },
          { expanded }
        )
        await panel.getByRole('button', { name: 'Continue translation' }).click()
        await expect.poll(() => heldTranslations.length).toBeGreaterThan(0)
        await expect(panel).toContainText('Translating…')
        await expect(reviewToggle).toHaveAttribute('aria-pressed', String(expanded))
        await expect(canvas).toHaveAttribute('data-stable-translation', 'true')
        expect(
          await canvas.evaluate(
            (node: HTMLCanvasElement, pixels) => node.toDataURL() === pixels,
            pixels
          )
        ).toBe(true)
        expect(
          await observer.evaluate((state) => {
            state.stop()
            return state.violations
          })
        ).toEqual([])
        await observer.dispose()
      }
      for (let done = 2; done <= 5; done++) {
        await expect.poll(() => heldTranslations.length).toBeGreaterThan(0)
        heldTranslations.shift()!()
        if (done < 5) await expect(panel).toContainText(`${done} / 5`)
        else
          await expect(
            panel.getByRole('button', { name: '5 Translated', exact: true })
          ).toBeVisible()
        // Progress must not destroy, clear or replace the displayed canvas.
        await expect(
          panel.getByRole('button', { name: 'Update PDF preview', exact: true })
        ).toBeVisible()
        await expect(canvas).toHaveAttribute('data-stable-translation', 'true')
        expect(
          await canvas.evaluate(
            (node: HTMLCanvasElement, pixels) => node.toDataURL() === pixels,
            pixels
          )
        ).toBe(true)
        await expect(page.getByText('Preparing translated PDF…', { exact: true })).toBeHidden()
        await expect(panel).toBeVisible()
        await expect(
          page.getByText("Open-Science couldn't display this page", { exact: true })
        ).toBeHidden()
        if (done === 2) {
          await page.screenshot({ path: testInfo.outputPath('translation-update-available.png') })
          // Explicit refresh also admits progress within an unfinished page.
          await panel.getByRole('button', { name: 'Update PDF preview', exact: true }).click()
          await expect(
            panel.getByRole('button', { name: 'Update PDF preview', exact: true })
          ).toBeHidden({ timeout: 60000 })
          await expect(page.getByText('Preparing translated PDF…', { exact: true })).toBeHidden({
            timeout: 60000
          })
          await expect(page.getByText('Checking translated PDF…', { exact: true })).toBeHidden({
            timeout: 60000
          })
          const second = page.locator('[data-page-number="2"] [data-pdf-translated-page]')
          await second.scrollIntoViewIfNeeded()
          await expect(second.locator('[data-pdf-text-layer]')).toContainText(
            '测量受控实验室培养物中的细胞生长。'
          )
          await expect(second.locator('[data-pdf-text-layer]')).toContainText('Cell growth')
          await canvas.scrollIntoViewIfNeeded()
          await expect(
            page
              .locator('[data-pdf-translated-page]')
              .first()
              .locator('[data-pdf-page-ready="true"]')
          ).toBeVisible()
          pixels = await canvas.evaluate((node: HTMLCanvasElement) => {
            node.dataset.stableTranslation = 'true'
            return node.toDataURL()
          })
        }
      }
      const scroller = page.getByRole('region', {
        name: 'paired-reading.pdf scrollable preview',
        exact: true
      })
      await scroller.evaluate((node) => {
        node.scrollTop = 100
      })
      const scrollTop = await scroller.evaluate((node) => node.scrollTop)
      // Completing the page automatically publishes the latest translated PDF.
      // Do not race its refresh button, which disappears when publication finishes.
      await expect(
        panel.getByRole('button', { name: 'Update PDF preview', exact: true })
      ).toBeHidden({ timeout: 60000 })
      await expect(
        page.locator('[data-pdf-translated-page]').first().locator('[data-pdf-page-ready="true"]')
      ).toBeVisible()
      await expect
        .poll(async () => Math.abs((await scroller.evaluate((node) => node.scrollTop)) - scrollTop))
        .toBeLessThan(2)
      // The completed second page is now readable after automatic refresh.
      const second = page.locator('[data-page-number="2"] [data-pdf-translated-page]')
      await second.scrollIntoViewIfNeeded()
      await expect(second.locator('[data-pdf-text-layer]')).toContainText(
        '测量受控实验室培养物中的细胞生长。'
      )
      await page
        .getByRole('button', { name: 'Download options for paired-reading.pdf', exact: true })
        .click()
      await expect(
        page.getByRole('menuitem', { name: 'Export translated PDF', exact: true })
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await page.screenshot({ path: testInfo.outputPath('streaming-reading.png') })
      const review = panel.getByRole('button', { name: 'Translation 5', exact: true })
      if ((await review.getAttribute('aria-pressed')) !== 'true') await review.click()
      await panel
        .getByRole('button', { name: /Page 1/ })
        .first()
        .click()
      const requestsBeforeRetry = directRequests.length
      holdTranslation = false
      replacementText = '在受控实验室培养物中测量细胞生长。'
      await canvas.scrollIntoViewIfNeeded()
      const oldCanvas = await canvas.elementHandle()
      await panel.getByRole('button', { name: 'Retranslate this paragraph', exact: true }).click()
      await expect(panel.locator('[data-translation-text]')).toContainText(replacementText)
      expect(directRequests).toHaveLength(requestsBeforeRetry + 1)
      await expect(review).toBeVisible()
      expect(await oldCanvas!.evaluate((node) => node.isConnected)).toBe(true)
      await expect(
        panel.getByRole('button', { name: 'Update PDF preview', exact: true })
      ).toBeVisible()
      await panel.getByRole('button', { name: 'Update PDF preview', exact: true }).click()
      await expect(
        page.locator('[data-pdf-translated-page]').first().locator('[data-pdf-text-layer]')
      ).toContainText(replacementText)
      expect(directRequests).toHaveLength(requestsBeforeRetry + 1)
      await page.screenshot({ path: testInfo.outputPath('paragraph-retranslated.png') })
      return
    }
    if (variant === 'close-confirmation') {
      await expect(panel).toContainText('1 / 4')
      const closePreview = page.getByRole('button', {
        name: 'Close preview of paired-reading.pdf',
        exact: true
      })
      const confirmation = page.getByTestId('stop-pdf-translation-confirmation')
      await closePreview.click()
      await expect(confirmation).toContainText('1 / 4')
      await confirmation.getByRole('button', { name: 'Continue translating', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
      await closePreview.click()
      await page.keyboard.press('Escape')
      await expect(confirmation).toBeHidden()
      await expect(panel).toBeVisible()
      await closePreview.click()
      await page.mouse.click(5, 5)
      await expect(confirmation).toBeHidden()
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await page.keyboard.press('Escape')
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: 'Continue translating', exact: true }).click()
      await page.getByRole('button', { name: /^Translating… / }).click()
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
      await closePreview.click()
      await page.screenshot({ path: testInfo.outputPath('confirm-stop-translation.png') })
      await confirmation.getByRole('button', { name: 'Stop and close', exact: true }).click()
      await expect(page.locator('[data-slot="file-preview-dialog"]')).toBeHidden()
      await page.getByRole('button', { name: 'Preview paired-reading.pdf', exact: true }).click()
      await page.getByRole('button', { name: /^(Full-text translation|View translation)$/ }).click()
      await expect(panel).toContainText('1 / 4')
      await page.screenshot({ path: testInfo.outputPath('paused-translation.png') })
      const originalViewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight
      }))
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 900 })
        const controls = panel.locator('[data-pdf-translation-controls]')
        await expect
          .poll(() => controls.evaluate((node) => node.scrollWidth - node.clientWidth))
          .toBeLessThanOrEqual(1)
        await expect(
          panel.getByRole('button', { name: 'Continue translation', exact: true })
        ).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`paused-translation-${width}.png`) })
      }
      await page.setViewportSize(originalViewport)
      await panel.getByRole('button', { name: 'Continue translation', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
      await closePreview.click()
      await expect(confirmation).toBeVisible()
      holdTranslation = false
      for (const release of heldTranslations) release()
      await expect(confirmation).toBeHidden({ timeout: 60000 })
      await expect(panel.getByRole('button', { name: '4 Translated', exact: true })).toBeVisible()
      await closePreview.click()
      await expect(page.locator('[data-slot="file-preview-dialog"]')).toBeHidden()
      await expect(confirmation).toBeHidden()
      return
    }
    if (variant === 'recovery') {
      await expect(panel).toContainText('1 / 4', { timeout: 60000 })
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(panel).toContainText('1 / 4')
      const restoredPage = await app.restart()
      const promptsBeforeResume = (await app.readFakeAgentPrompts()).filter((entry) =>
        entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
      ).length
      await restoredPage.getByRole('button', { name: 'Library', exact: true }).click()
      await restoredPage.getByRole('button', { name: 'All references', exact: true }).click()
      await restoredPage
        .getByRole('button', { name: 'Preview paired-reading.pdf', exact: true })
        .click()
      await restoredPage
        .getByRole('button', { name: /^(Full-text translation|View translation)$/ })
        .click()
      const restoredPanel = restoredPage.locator('[data-pdf-translation-sidebar]')
      await expect(restoredPanel).toContainText('1 / 4', { timeout: 30000 })
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(promptsBeforeResume)
      await restoredPage.screenshot({ path: testInfo.outputPath('restored-partial.png') })
      await restoredPanel.getByRole('button', { name: 'Continue translation', exact: true }).click()
      await expect(
        restoredPanel.getByRole('button', { name: '4 Translated', exact: true })
      ).toBeVisible({ timeout: 60000 })
      await expect(
        restoredPanel.getByRole('button', { name: 'View translated PDF', exact: true })
      ).toBeEnabled()
      // One unsupported batch plus the three remaining paragraphs; the saved paragraph is reused.
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(promptsBeforeResume + 4)
      await selectRendition(restoredPage, 'Compare')
      await expect(restoredPage.locator('[data-page-number="1"] canvas')).toHaveCount(2)
      await restoredPage.screenshot({ path: testInfo.outputPath('resumed-complete.png') })
      return
    }
    if (variant === 'busy') {
      await expect(panel).toContainText('3 / 4', { timeout: 60000 })
      // Wait for the previous page generation to release its slot before occupying both.
      await expect(panel.getByRole('button', { name: '0 Not in PDF', exact: true })).toBeVisible()
      // Occupy the actual writer slots with bounded requests, then cancel them below.
      // No replacement IPC, mocked error state, or provider response changes.
      await page.evaluate((bytes) => {
        const api = window.api.pdfTranslation
        if (!api) throw new Error('PDF translation API is unavailable')
        const requests = ['pdf-capacity-a', 'pdf-capacity-b'].map((id) =>
          api.generatePdf({
            id,
            data: new Uint8Array(bytes),
            pages: Array.from({ length: 4 }, () => ({ width: 612, height: 792 })),
            units: Array.from({ length: 5000 }, () => ({
              source: 'Cell growth is measured in controlled laboratory cultures.',
              translation: '测量受控实验室培养物中的细胞生长。'.repeat(4),
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 60 / 792, width: 530 / 612, height: 40 / 792 }
                }
              ]
            }))
          })
        )
        ;(window as Window & { pdfCapacityDone?: Promise<unknown> }).pdfCapacityDone =
          Promise.allSettled(requests)
      }, bytes)
    }
    await expect(panel.getByRole('button', { name: '4 Translated', exact: true })).toBeVisible({
      timeout: 60000
    })
    await expect(panel.getByText('Preparing translated PDF…', { exact: true })).toBeHidden({
      timeout: 60000
    })
    await expect(panel.getByText('Checking translated PDF…', { exact: true })).toBeHidden({
      timeout: 60000
    })
    const updatePreview = panel.getByRole('button', { name: 'Update PDF preview', exact: true })
    if (variant === 'busy') {
      await expect(async () => {
        if (await updatePreview.isVisible()) await updatePreview.click({ timeout: 1000 })
      }).toPass({ timeout: 5000 })
    } else {
      // Completing the page automatically publishes the PDF. Wait for publication
      // before using the reader or requesting an explicit layout retry.
      await expect(updatePreview).toBeHidden({ timeout: 60000 })
    }
    const failure = panel.getByRole('alert')
    let promptsBeforeRetry: Awaited<ReturnType<typeof app.readFakeAgentPrompts>> | undefined
    if (variant === 'busy') {
      await expect(failure).toContainText(
        'PDF generation is busy. Retry after another document finishes.'
      )
      await openReadingView(page)
      await expect(
        page
          .getByRole('group', { name: 'PDF rendition' })
          .getByRole('button', { name: 'Compare', exact: true })
      ).toBeEnabled()
      await page.keyboard.press('Escape')
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      await expect(panel).toBeHidden()
      await expect(page.getByRole('alert')).toHaveCount(0)
      const translationEntry = page.getByRole('button', { name: 'View translation', exact: true })
      await translationEntry.hover()
      await expect(page.getByRole('tooltip')).toHaveText('Could not prepare translated PDF')
      await page.screenshot({ path: testInfo.outputPath('pdf-generation-sidebar-closed.png') })
      await translationEntry.click()
      await expect(failure).toContainText('PDF generation is busy.')
      await page.screenshot({ path: testInfo.outputPath('pdf-generation-retry.png') })
      await page.evaluate(async () => {
        const api = window.api.pdfTranslation
        if (!api) throw new Error('PDF translation API is unavailable')
        await Promise.all(['pdf-capacity-a', 'pdf-capacity-b'].map((id) => api.cancelPdf(id)))
        const scope = window as Window & { pdfCapacityDone?: Promise<unknown> }
        await scope.pdfCapacityDone
        delete scope.pdfCapacityDone
      })
      promptsBeforeRetry = await app.readFakeAgentPrompts()
      // One unsupported batch falls back to four individual paragraph requests.
      expect(
        promptsBeforeRetry.filter((entry) => entry.prompt.includes('PAIR_PDF_ACCEPTANCE'))
      ).toHaveLength(5)
      await page.getByRole('button', { name: 'Retry PDF generation', exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(
        panel.getByRole('button', { name: 'Close translation', exact: true })
      ).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath('pdf-generation-retry-focused.png') })
    }
    await expect(panel.getByText('Preparing translated PDF…', { exact: true })).toBeHidden({
      timeout: 30000
    })
    await expect(
      panel.getByText(
        'This layout could not be preserved safely. The text translation is still available.'
      )
    ).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (variant === 'direct-api') {
      await panel.getByRole('button', { name: 'Translation 4', exact: true }).click()
      await expect(panel).toContainText('测量受控实验室培养物中的细胞生长。')
      await expect(panel).not.toContainText('PRIVATE_')
      await expect(panel).not.toContainText('<think>')
      await page.screenshot({ path: testInfo.outputPath('clean-translation-sidebar.png') })
      const settings = panel.getByRole('button', { name: /^Translation settings(?: |$)/ })
      if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
      await panel.getByRole('button', { name: 'New translation', exact: true }).click()
      const newTranslation = page.getByRole('dialog', { name: 'New translation', exact: true })
      await newTranslation.getByRole('combobox', { name: 'Translation method' }).click()
      await page.getByRole('option', { name: 'Agent', exact: true }).click()
      await newTranslation.getByRole('combobox', { name: 'Translation method' }).click()
      await page.getByRole('option', { name: 'Direct API', exact: true }).click()
      const startTranslation = newTranslation.getByRole('button', {
        name: 'Translate document',
        exact: true
      })
      const reason = 'Select a model to continue.'
      await expect(startTranslation).toBeDisabled()
      await startTranslation.hover({ force: true })
      await expect(page.getByRole('tooltip')).toHaveText(reason)
      await page.screenshot({ path: testInfo.outputPath('new-translation-disabled-reason.png') })
      await newTranslation.getByRole('button', { name: 'Cancel', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(newTranslation.getByRole('group', { name: reason })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(newTranslation).toBeVisible()
      await newTranslation.getByRole('combobox', { name: 'Model', exact: true }).click()
      await page
        .getByRole('option', {
          name: 'translation-test · Local direct translation test',
          exact: true
        })
        .click()
      await expect(startTranslation).toBeEnabled()
      await expect(newTranslation.getByRole('group', { name: reason })).toHaveCount(0)
      await newTranslation
        .getByRole('button', { name: 'Translation glossary', exact: true })
        .click()
      const glossary = newTranslation.getByRole('group', {
        name: 'Translation glossary',
        exact: true
      })
      for (let index = (await glossary.getByRole('textbox').count()) / 2; index < 24; index++) {
        await glossary.getByRole('button', { name: 'Add term', exact: true }).click()
        await glossary.getByLabel(`Source term ${index + 1}`, { exact: true }).fill(`term ${index}`)
        await glossary
          .getByLabel(`Preferred translation ${index + 1}`, { exact: true })
          .fill('术语')
      }
      await newTranslation.getByRole('button', { name: 'Advanced', exact: true }).click()
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      for (const height of [720, 480]) {
        await page.setViewportSize({ width: 1024, height })
        await expect(glossary.getByRole('textbox')).toHaveCount(48)
        await expect
          .poll(() =>
            glossary
              .locator('div.overflow-y-auto')
              .evaluate((element) => element.scrollHeight > element.clientHeight)
          )
          .toBe(true)
        const bounds = await newTranslation.boundingBox()
        expect(bounds!.y).toBeGreaterThanOrEqual(15)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height - 15)
        for (const button of [
          startTranslation,
          newTranslation.getByRole('button', { name: 'Cancel', exact: true })
        ]) {
          const buttonBounds = await button.boundingBox()
          expect(buttonBounds!.y).toBeGreaterThanOrEqual(15)
          expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(height - 15)
        }
        // Trial clicks check real hit targets without starting another translation.
        await startTranslation.click({ trial: true })
        await newTranslation
          .getByRole('button', { name: 'Cancel', exact: true })
          .click({ trial: true })
        await newTranslation
          .getByRole('combobox', { name: 'Concurrent translations', exact: true })
          .click()
        await page.getByRole('option', { name: '4x', exact: true }).click()
        await page.screenshot({ path: testInfo.outputPath(`long-glossary-${height}.png`) })
      }
      await newTranslation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(newTranslation).toBeHidden()
      await page.setViewportSize(viewport)
    }
    const modes = page.getByRole('group', { name: 'PDF rendition' })
    if (variant === 'agent-model') {
      const checkpoint = await page.evaluate(
        (id) => window.api.pdfTranslation!.readCheckpoint(id),
        fixtureVersionId
      )
      expect(checkpoint?.model).toMatchObject({
        mode: 'agent',
        frameworkId: 'opencode',
        providerId: agentProviderId,
        modelId: 'e2e-model'
      })
      const currentSettings = await page.evaluate(() => window.api.settings.getSettings())
      expect(currentSettings.activeProviderId).toBe(settingsBefore.activeProviderId)
      expect(currentSettings.activeModel).toBe(settingsBefore.activeModel)
      const settings = panel.getByRole('button', { name: /^Translation settings(?: |$)/ })
      if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
      await panel.getByRole('button', { name: 'New translation', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'New translation', exact: true })
      await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
        'e2e-model'
      )
      await dialog.getByRole('combobox', { name: 'Model', exact: true }).click()
      await page.getByRole('option', { name: 'Main model', exact: true }).click()
      await expect(
        dialog.getByRole('button', { name: 'Translate document', exact: true })
      ).toBeEnabled()
      await page.screenshot({ path: testInfo.outputPath('new-translation-agent-model.png') })
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await selectRendition(page, 'Compare')
    if (!(await panel.isVisible()))
      await page.getByRole('button', { name: 'View translation', exact: true }).click()
    await panel.getByRole('button', { name: 'Search translation', exact: true }).click()
    await expect(
      panel.getByRole('textbox', { name: 'Search translation', exact: true })
    ).toBeFocused()
    await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'View translation', exact: true })).toBeFocused()
    await expect(panel).toBeHidden()
    const scroll = page.getByRole('region', { name: 'paired-reading.pdf scrollable preview' })
    const first = scroll.locator('[data-page-number="1"]')
    await expect(first.locator('canvas')).toHaveCount(2)
    if (variant === 'retained-paragraph') {
      await page.getByRole('button', { name: 'View translation', exact: true }).click()
      await expect(
        panel.getByRole('button', { name: 'Review retained passages', exact: true })
      ).toHaveCount(0)
      const marker = first
        .locator('[data-pdf-translated-page]')
        .getByRole('button', { name: /Read paragraph/ })
      const review = panel.getByRole('button', { name: /^Translation \d+$/ })
      if ((await review.getAttribute('aria-pressed')) === 'true') await review.click()
      await expect(marker).toHaveCount(0)
      await review.click()
      await expect(marker).toHaveCount(1)
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      await expect(marker).toHaveCount(0)
      await page.getByRole('button', { name: 'View translation', exact: true }).click()
      await expect(marker).toHaveCount(1)
      await marker.click()
      await expect(
        panel.getByText(
          'This passage is translated, but its original layout was retained in the PDF.'
        )
      ).toHaveCount(0)
      await expect(
        panel.getByText(
          'This PDF contains links or annotations that cannot yet be preserved safely.'
        )
      ).toHaveCount(0)
      const warning = panel.getByRole('img', { name: 'Text kept in original layout', exact: true })
      await warning.focus()
      const warningTip = page.getByRole('tooltip')
      await expect(warningTip).toContainText(
        'This passage is translated, but its original layout was retained in the PDF.'
      )
      await expect(warningTip).toContainText(
        'This PDF contains links or annotations that cannot yet be preserved safely.'
      )
      await page.screenshot({ path: testInfo.outputPath('retained-paragraph-tip.png') })
      await marker.focus()
      await expect(
        panel.getByRole('button', { name: 'Retranslate this paragraph', exact: true })
      ).toBeVisible()
      const calls = directRequests.length
      await panel.getByRole('button', { name: 'Retry PDF layout', exact: true }).click()
      await expect(
        panel.getByRole('button', { name: 'Layout unchanged', exact: true })
      ).toBeDisabled({ timeout: 60000 })
      expect(directRequests).toHaveLength(calls)
      await expect(first.locator('[data-pdf-translated-page] [data-pdf-text-layer]')).toContainText(
        'Cell growth'
      )
      await expect
        .poll(async () => {
          const checkpoint = await page.evaluate(
            (source) => window.api.pdfTranslation!.readCheckpoint(source),
            fixtureVersionId
          )
          return checkpoint?.layoutReports
            ?.filter((report) => report.failure)
            .map((report) => report.failure?.code)
        })
        .toEqual(['annotations'])
      await page.screenshot({ path: testInfo.outputPath('retained-paragraph-actions.png') })
      await page.setViewportSize({ width: 1024, height: 480 })
      const header = panel.locator('[data-translation-review-header]')
      await header.evaluate((node) => {
        const scroller = node.parentElement!.parentElement!
        scroller.scrollTop = scroller.scrollHeight
      })
      await expect
        .poll(() =>
          header.evaluate((node) => {
            const scroller = node.parentElement!.parentElement!
            return Math.abs(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
          })
        )
        .toBeLessThan(2)
      await expect(
        panel.getByRole('button', { name: 'Filter translations', exact: true })
      ).toBeInViewport()
      await expect(panel.getByRole('group', { name: 'Translation progress' })).toBeInViewport()
      for (const label of await panel
        .getByRole('group', { name: 'Translation progress' })
        .locator('button > span:last-child')
        .all()) {
        expect(await label.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap')
      }
      expect(await marker.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)'
      )
      await page.screenshot({ path: testInfo.outputPath('translation-sidebar-sticky.png') })

      const reopenedPage = await app.restart()
      const saved = await reopenedPage.evaluate(
        (source) => window.api.pdfTranslation!.readCheckpoint(source),
        fixtureVersionId
      )
      expect(saved?.layoutReports?.filter((report) => report.failure)).toMatchObject([
        {
          sourceIndex: 0,
          failure: { code: 'annotations', phase: 'planning', pageNumbers: [1], fragmentCount: 1 }
        }
      ])
      expect(directRequests).toHaveLength(calls)
      return
    }
    if (variant === 'annotated') {
      await expect(first.getByRole('button', { name: 'Annotation note', exact: true })).toHaveCount(
        1
      )
      await expect(
        first
          .locator('[data-pdf-translated-page]')
          .getByRole('button', { name: 'Annotation note', exact: true })
      ).toHaveCount(0)
    }
    await expect(first.locator('[data-pdf-translated-page] [data-pdf-text-layer]')).toContainText(
      '测量受控实验室培养物中的细胞生长。'
    )
    if (hasInlineLinks)
      for (const pattern of [
        ...(variant === 'inline-link' ? [/^Methods:\s*$/] : []),
        /^\[1\]$/,
        /^\[2\]$/
      ]) {
        const marker = first.locator('[data-pdf-text-layer] span').filter({ hasText: pattern })
        await expect(marker).toHaveCount(2)
        const positions = await marker.evaluateAll((nodes) =>
          nodes.map((node) => ({
            x:
              node.getBoundingClientRect().left -
              node.closest('[data-pdf-text-layer]')!.getBoundingClientRect().left,
            y:
              node.getBoundingClientRect().top -
              node.closest('[data-pdf-text-layer]')!.getBoundingClientRect().top
          }))
        )
        if (variant === 'reflow-link')
          expect(
            Math.hypot(positions[0].x - positions[1].x, positions[0].y - positions[1].y)
          ).toBeGreaterThan(1)
        else {
          expect(Math.abs(positions[0].x - positions[1].x)).toBeLessThan(1)
          expect(Math.abs(positions[0].y - positions[1].y)).toBeLessThan(1)
        }
      }
    if (promptsBeforeRetry) {
      expect(await app.readFakeAgentPrompts()).toEqual(promptsBeforeRetry)
      await page.screenshot({ path: testInfo.outputPath('pdf-generation-recovered.png') })
    }
    if (await panel.isVisible())
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
    if (variant === 'direct-api') {
      await expect(
        first.locator('[data-pdf-translated-page] [data-pdf-text-layer]')
      ).not.toContainText('PRIVATE_')
      await expect(
        first.locator('[data-pdf-translated-page] [data-pdf-text-layer]')
      ).not.toContainText('<think>')
      expect(directRequests).toHaveLength(5)
      expect(paragraphRequests).toBe(4)
      for (const request of directRequests) {
        expect(request.model).toBe('translation-test')
        expect(request).not.toHaveProperty('tools')
        const messages = request.messages as Array<{ role: string; content: string }>
        expect(messages).toHaveLength(2)
        const prompt = JSON.parse(messages[1].content)
        const sources = prompt.units ?? [prompt]
        for (const unit of sources) {
          expect(unit.source).toBe('Cell growth is measured in controlled laboratory cultures.')
        }
      }
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(0)
    }
    await page.screenshot({ path: testInfo.outputPath('paired-pdfs.png') })
    const assertAligned = async (): Promise<void> => {
      const pages = await first.locator('canvas').evaluateAll((nodes) =>
        nodes.map((n) => ({
          top: n.getBoundingClientRect().top,
          width: n.getBoundingClientRect().width,
          height: n.getBoundingClientRect().height
        }))
      )
      expect(pages).toHaveLength(2)
      expect(Math.abs(pages[0].top - pages[1].top)).toBeLessThan(1)
      expect(Math.abs(pages[0].width - pages[1].width)).toBeLessThan(1)
      expect(Math.abs(pages[0].height - pages[1].height)).toBeLessThan(1)
    }
    await assertAligned()
    if (variant === 'standard') {
      const translationToggle = page.getByRole('button', {
        name: 'View translation',
        exact: true
      })
      const notes = page.locator('[data-pdf-notes-sidebar]')
      await translationToggle.click()
      await expect(panel).toBeVisible()
      const translationBounds = await panel.boundingBox()
      await page.getByRole('button', { name: 'Show notes sidebar', exact: true }).click()
      await expect(notes).toBeVisible()
      expect(await notes.boundingBox()).toEqual(translationBounds)
      const separator = page.getByRole('separator', { name: 'Resize notes sidebar' })
      await separator.focus()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      await expect(separator).toHaveAttribute('aria-valuenow', '352')
      const resizedBounds = await notes.boundingBox()
      const originalBounds = await page.locator('[data-pdf-original-view]').boundingBox()
      await page.screenshot({ path: testInfo.outputPath('notes-sidebar-shared-width.png') })
      await translationToggle.click()
      await expect(panel).toBeVisible()
      expect(await panel.boundingBox()).toEqual(resizedBounds)
      expect(await page.locator('[data-pdf-original-view]').boundingBox()).toEqual(originalBounds)
      await page.screenshot({ path: testInfo.outputPath('translation-sidebar-shared-width.png') })
      const pdfDetails = panel.getByRole('button', {
        name: 'About the translated PDF',
        exact: true
      })
      await expect(pdfDetails).toHaveCount(0)
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      const markers = scroll.getByRole('button', { name: /Read paragraph \d+ translation/ })
      const toggle = page.getByRole('button', { name: 'Paragraph markers', exact: true })
      await expect(markers).toHaveCount(0)
      await openReadingView(page)
      await toggle.focus()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await expect(markers.first()).toBeVisible()
      await markers.first().click()
      await expect(panel).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
      await expect(panel.getByText(/Keep the same model when retrying/)).toHaveCount(0)
      await expect(panel.getByText('Full text prepared', { exact: true })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('translation-review-sidebar.png') })
      const expandedParagraph = panel.getByRole('button', { name: 'Page 1 · #1', exact: true })
      await expect(expandedParagraph).toHaveAttribute('aria-expanded', 'true')
      await expandedParagraph.focus()
      await page.keyboard.press('Enter')
      await expect(
        panel.getByRole('button', { name: 'Select full paragraph', exact: true })
      ).toHaveCount(0)
      await expect(markers.first()).toHaveAttribute('aria-pressed', 'false')
      await markers.first().click()
      await expect(expandedParagraph).toHaveAttribute('aria-expanded', 'true')
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      await openReadingView(page)
      await toggle.click()
      await page.keyboard.press('Escape')
      await expect(markers).toHaveCount(0)
      await expect(scroll.locator('[data-translation-source]')).toHaveCount(0)
    }
    if (
      ['links', 'inline-link', 'multiline-link', 'reflow-link', 'cropped', 'rotated'].includes(
        variant
      )
    ) {
      await page.getByRole('button', { name: 'Select', exact: true }).click()
      const originalLink = first.locator('[data-pdf-native-links] a').first()
      const translatedLinks = first.locator('[data-pdf-translated-page] [data-pdf-native-links] a')
      await expect(translatedLinks).toHaveCount(hasInlineLinks ? 2 : 1)
      const translatedLink = translatedLinks.last()
      if (['cropped', 'rotated'].includes(variant)) {
        const expected =
          variant === 'rotated'
            ? { x: 90 / 730, y: 200 / 570, width: 25 / 730, height: 60 / 570 }
            : { x: 200 / 570, y: 615 / 730, width: 60 / 570, height: 25 / 730 }
        for (const link of [originalLink, translatedLink]) {
          const geometry = await link.evaluate((node) => {
            const page = node.closest('[data-pdf-page-rotation]')!.getBoundingClientRect()
            const link = node.getBoundingClientRect()
            return {
              pageWidth: page.width,
              pageHeight: page.height,
              x: (link.left - page.left) / page.width,
              y: (link.top - page.top) / page.height,
              width: link.width / page.width,
              height: link.height / page.height
            }
          })
          for (const key of ['x', 'y', 'width', 'height'] as const) {
            const dimension =
              key === 'x' || key === 'width' ? geometry.pageWidth : geometry.pageHeight
            // PDF.js rounds layer dimensions down to CSS pixels.
            expect(Math.abs(geometry[key] - expected[key]) * dimension).toBeLessThan(1.01)
          }
        }
      }
      const goToFirst = async (): Promise<void> => {
        const viewport = await scroll.boundingBox()
        await page.mouse.move(viewport!.x + viewport!.width / 2, viewport!.y + 100)
        // Real scroll intent cancels a destination still waiting for its text layer.
        await page.mouse.wheel(0, -10000)
        await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(0)
        await expect(originalLink).toBeVisible()
        await expect(page.getByRole('button', { name: 'Page 1 of 4', exact: true })).toBeVisible()
      }
      await translatedLink.click()
      await expect(page.getByRole('button', { name: 'Page 2 of 4', exact: true })).toBeVisible()
      await goToFirst()
      await page.mouse.move(10, 10)
      await scroll.focus()
      // Tab from the scroller through the annotation surface to its native links.
      for (let step = 0; step < 8; step++) {
        await page.keyboard.press('Tab')
        if (await originalLink.evaluate((node) => node === document.activeElement)) break
      }
      await expect(originalLink).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath('native-link-focused.png') })
      const originTop = await scroll.evaluate((node) => node.scrollTop)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Page 2 of 4', exact: true })).toBeVisible()
      if (hasInlineLinks) {
        const targetPoint = async (): Promise<number> =>
          scroll.evaluate((node) => {
            const page = node
              .querySelector('[data-page-number="2"] [data-pdf-page-rotation]')!
              .getBoundingClientRect()
            return page.top + (340 / 792) * page.height - node.getBoundingClientRect().top
          })
        await expect.poll(targetPoint).toBeCloseTo(72, 0)
        await expect(page.getByRole('button', { name: 'Reset zoom', exact: true })).toBeDisabled()
        const destinationTop = await scroll.evaluate((node) => node.scrollTop)
        await page.getByRole('button', { name: 'Previous reading position', exact: true }).click()
        await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeCloseTo(originTop, 0)
        await page.getByRole('button', { name: 'Next reading position', exact: true }).click()
        await expect
          .poll(() => scroll.evaluate((node) => node.scrollTop))
          .toBeCloseTo(destinationTop, 0)
        await page.screenshot({ path: testInfo.outputPath('native-link-history.png') })
      }
      await goToFirst()
      await page.getByRole('button', { name: 'Hand', exact: true }).click()
      await expect(first.locator('[data-pdf-native-links]').first()).toHaveAttribute('inert', '')
      await page.getByRole('button', { name: 'Select', exact: true }).click()
      await expect(first.locator('[data-pdf-native-links]').first()).not.toHaveAttribute(
        'inert',
        ''
      )
    }
    const bounds = await first.locator('[data-pdf-translated-page]').boundingBox()
    await page.mouse.move(bounds!.x + 40, bounds!.y + 100)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(100)
    await assertAligned()
    const beforeZoom = await first
      .locator('canvas')
      .first()
      .evaluate((node) => node.getBoundingClientRect().width)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect
      .poll(() =>
        first
          .locator('canvas')
          .first()
          .evaluate((node) => node.getBoundingClientRect().width)
      )
      .toBeGreaterThan(beforeZoom)
    await assertAligned()
    await selectRendition(page, 'Translation')
    await expect(first.locator('canvas')).toHaveCount(1)
    const viewport = await scroll.boundingBox()
    await page.mouse.move(viewport!.x + viewport!.width / 2, viewport!.y + 100)
    await page.mouse.wheel(0, -3000)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0)
    await expect(first.locator('[data-pdf-text-layer]')).toContainText(
      '测量受控实验室培养物中的细胞生长。'
    )
    await page.screenshot({ path: testInfo.outputPath('translated-pdf.png') })
    let translatedOriginTop = 0
    if (hasInlineLinks) {
      await first.locator('[data-pdf-native-links] a').last().focus()
      translatedOriginTop = await scroll.evaluate((node) => node.scrollTop)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Page 2 of 4', exact: true })).toBeVisible()
    }
    await selectRendition(page, 'Compare')
    if (hasInlineLinks) {
      // The view menu stays outside the scroller; changing rendition preserves the link target.
      await expect(scroll.locator('[data-page-number="2"] canvas')).toHaveCount(2)
      const compareTop = await scroll.evaluate((node) => node.scrollTop)
      await page.getByRole('button', { name: 'Previous reading position', exact: true }).click()
      await expect(first.locator('canvas')).toHaveCount(1)
      await openReadingView(page)
      await expect(modes.getByRole('button', { name: 'Translation', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page.keyboard.press('Escape')
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBeCloseTo(translatedOriginTop, 0)
      await page.screenshot({ path: testInfo.outputPath('native-link-returned.png') })
      await page.getByRole('button', { name: 'Next reading position', exact: true }).click()
      await openReadingView(page)
      await expect(modes.getByRole('button', { name: 'Compare', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page.keyboard.press('Escape')
      await expect(scroll.locator('[data-page-number="2"] canvas')).toHaveCount(2)
      await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeCloseTo(compareTop, 0)
    }
    if (variant === 'standard') {
      await page.getByRole('button', { name: 'View translation', exact: true }).click()
      await panel.getByRole('button', { name: 'Search translation', exact: true }).click()
      await panel
        .getByRole('textbox', { name: 'Search translation', exact: true })
        .fill('previous translation only')
      await expect(panel.getByText('No translation matches', { exact: true })).toBeVisible()
      const settings = panel.getByRole('button', { name: /^Translation settings(?: |$)/ })
      if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click()
      await panel.getByRole('button', { name: 'New translation', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'New translation', exact: true })
      await expect(
        dialog.getByRole('combobox', { name: 'Target language', exact: true })
      ).toHaveValue('Chinese')
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(5)
      await page.screenshot({ path: testInfo.outputPath('new-translation-ready.png') })
      await dialog.getByRole('button', { name: 'Translate document', exact: true }).click()
      await expect(panel.getByRole('button', { name: '4 Translated', exact: true })).toBeVisible({
        timeout: 60000
      })
      await panel.getByRole('button', { name: 'Search translation', exact: true }).click()
      await expect(
        panel.getByRole('textbox', { name: 'Search translation', exact: true })
      ).toHaveValue('')
      await expect(panel.getByText('No translation matches', { exact: true })).toHaveCount(0)
      await openReadingView(page)
      await expect(modes.getByRole('button', { name: 'Original', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(10)
      await selectRendition(page, 'Compare')
      await expect(first.locator('[data-pdf-translated-page] canvas')).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('new-translation-paired.png') })
      if (!(await panel.isVisible()))
        await page.getByRole('button', { name: 'View translation', exact: true }).click()
      const application = (app as unknown as { application: ElectronApplication }).application
      const exportedPath = testInfo.outputPath('translated.pdf')
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, exportedPath)
      await page
        .getByRole('button', { name: 'Download options for paired-reading.pdf', exact: true })
        .click()
      await page.getByRole('menuitem', { name: 'Export translated PDF', exact: true }).click()
      await expect(panel.getByText('Translated PDF saved.', { exact: true })).toBeVisible()
      const exported = await PDFDocument.load(await readFile(exportedPath))
      expect(exported.getPageCount()).toBe(4)
      expect(exported.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
      await page.screenshot({ path: testInfo.outputPath('translated-export.png') })
      await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      await selectRendition(page, 'Translation')
      await scroll.focus()
      await page.keyboard.press('ControlOrMeta+f')
      await page.getByRole('searchbox', { name: 'Search document', exact: true }).fill('细胞')
      await expect(
        page.getByRole('button', { name: 'Search in Translation', exact: true })
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeEnabled()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const ranges = [...(CSS.highlights.get('pdf-search-results') ?? [])]
            return (
              ranges.length > 0 &&
              ranges.every((range) =>
                range.startContainer.parentElement?.closest('[data-pdf-translated-page]')
              )
            )
          })
        )
        .toBe(true)
      const search = page.getByRole('searchbox', { name: 'Search document', exact: true })
      // The find bar publishes the first match before all pages finish searching.
      await expect(search.locator('..').getByText('1/4', { exact: true })).toBeVisible()
      await search.press('Enter')
      await expect(search.locator('..').getByText('2/4', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Page 2 of 4', exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('translated-search.png') })
      await page.keyboard.press('Escape')
      await selectRendition(page, 'Compare')
      await scroll.evaluate((element) => {
        element.scrollTop = 0
      })
    }
    const reader = page.locator('[data-pdf-preview-root]')
    if (variant === 'standard') {
      for (const width of [320, 375, 414, 768]) {
        await reader.evaluate((element, width) => {
          element.style.width = `${width}px`
          element.style.maxWidth = `${width}px`
        }, width)
        await expect.poll(() => reader.evaluate((element) => element.clientWidth)).toBe(width)
        await page.getByRole('button', { name: 'View translation', exact: true }).click()
        await expect(panel).toBeVisible()
        await expect
          .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBe(0)
        await expect(
          panel.getByRole('button', { name: 'Close translation', exact: true })
        ).toBeInViewport()
        await panel.getByRole('button', { name: 'Close translation', exact: true }).click()
      }
    }
    await reader.evaluate((element) => {
      element.style.width = '375px'
      element.style.maxWidth = '375px'
    })
    await expect.poll(() => reader.evaluate((element) => element.clientWidth)).toBe(375)
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true)
    expect(
      await first.evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length)
    ).toBe(2)
    await selectRendition(page, 'Original')
    await expect(scroll.locator('[data-pdf-translated-page]')).toHaveCount(0)
    await page
      .getByRole('button', { name: 'Close preview of paired-reading.pdf', exact: true })
      .click()
    await expect(page.locator('[data-pdf-preview-root]')).toHaveCount(0)
    if (variant === 'direct-api') {
      const usagePage = await app.restart()
      const events = (
        await usagePage.evaluate(() => window.api.sessions.loadUsage())
      ).usageEvents.filter((event) => event.source === 'literature-translation')
      expect(events).toHaveLength(directRequests.length)
      for (const event of events)
        expect(event).toMatchObject({
          inputTokens: 80,
          cacheTokens: 20,
          outputTokens: 12,
          usageIncomplete: false
        })
      await usagePage.getByRole('button', { name: 'Settings', exact: true }).click()
      await usagePage.getByRole('button', { name: 'Usage', exact: true }).click()
      await expect(usagePage.locator('[data-slot="translation-usage"]')).toContainText('560')
      await usagePage.screenshot({ path: testInfo.outputPath('translation-usage-accounting.png') })
    }
    if (variant === 'standard') {
      const resumedPage = await app.restart()
      await resumedPage.getByRole('button', { name: 'Library', exact: true }).click()
      await resumedPage.getByRole('button', { name: 'All references', exact: true }).click()
      await resumedPage
        .getByRole('button', { name: 'Preview paired-reading.pdf', exact: true })
        .click()
      await resumedPage
        .getByRole('button', { name: /^(Full-text translation|View translation)$/ })
        .click()
      const restoredPanel = resumedPage.locator('[data-pdf-translation-sidebar]')
      await expect(
        restoredPanel.getByRole('button', { name: '4 Translated', exact: true })
      ).toBeVisible({ timeout: 30000 })
      await expect(
        restoredPanel.getByRole('button', { name: 'View translated PDF', exact: true })
      ).toBeEnabled()
      expect(
        (await app.readFakeAgentPrompts()).filter((entry) =>
          entry.prompt.includes('PAIR_PDF_ACCEPTANCE')
        )
      ).toHaveLength(10)
      await selectRendition(resumedPage, 'Compare')
      await expect(resumedPage.locator('[data-page-number="1"] canvas')).toHaveCount(2)
      await resumedPage.screenshot({ path: testInfo.outputPath('restored-translation.png') })
    }
  })
}
