import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createProject, sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'

const chartNames = ['dense-scatter-a.pdf', 'dense-scatter-b.pdf', 'ordinary-scatter.pdf']

test('publishes PDF charts in a live conversation and opens the original', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  await createProject(page, 'PDF chart previews')
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await page.evaluate(() => {
    const metrics = {
      events: [] as { stage: string; at: number; id?: number; name?: string }[],
      longFrames: [] as {
        at: number
        duration: number
        blocking: number
        scripts: Array<{ duration: number; functionName: string; url: string }>
      }[],
      domMutations: [] as { at: number; duration: number; added: number; removed: number }[],
      resizeCallbacks: [] as { at: number; duration: number; width: number; height: number }[],
      layoutShifts: [] as { at: number; value: number; hadRecentInput: boolean }[],
      wheelFrames: [] as { at: number; delay: number }[]
    }
    const browser = window as typeof window & {
      pdfjsLib?: typeof import('pdfjs-dist')
      pdfChartMetrics: typeof metrics
    }
    browser.pdfChartMetrics = metrics
    const mark = (stage: string, id?: number, name?: string): void => {
      metrics.events.push({ stage, at: performance.now(), id, name })
    }
    const pdf = browser.pdfjsLib
    if (!pdf) throw new Error('PDF.js was not initialized')
    const getDocument = pdf.getDocument
    let nextId = 0
    pdf.getDocument = (options) => {
      const id = ++nextId
      mark('get-document', id)
      const task = getDocument(options)
      void task.promise.then(
        (document) => {
          mark('document-ready', id)
          const getPage = document.getPage.bind(document)
          document.getPage = async (number) => {
            const result = await getPage(number)
            mark('page-ready', id)
            const render = result.render.bind(result)
            result.render = (parameters) => {
              mark('draw', id)
              const drawing = render(parameters)
              void drawing.promise.then(
                () => mark('drawn', id),
                () => mark('draw-cancelled', id)
              )
              return drawing
            }
            return result
          }
        },
        () => mark('document-cancelled', id)
      )
      return task
    }
    const scroller = '[data-slot="message-scroller-viewport"]'
    const published = new Set<string>()
    new MutationObserver((records) => {
      const started = performance.now()
      for (const card of document.querySelectorAll<HTMLButtonElement>(
        `${scroller} button[aria-label^="Preview generated file "]`
      )) {
        if (card.disabled) continue
        const name = card.getAttribute('aria-label')!
        if (published.has(name)) continue
        published.add(name)
        mark('card-published', undefined, name)
      }
      metrics.domMutations.push({
        at: started,
        duration: performance.now() - started,
        added: records.reduce((total, record) => total + record.addedNodes.length, 0),
        removed: records.reduce((total, record) => total + record.removedNodes.length, 0)
      })
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled']
    })
    const scrollerElement = document.querySelector(scroller)
    if (scrollerElement) {
      new ResizeObserver((entries) => {
        const started = performance.now()
        const entry = entries.at(-1)
        const box = entry?.contentRect
        metrics.resizeCallbacks.push({
          at: started,
          duration: performance.now() - started,
          width: box?.width ?? 0,
          height: box?.height ?? 0
        })
      }).observe(scrollerElement)
    }
    document.addEventListener(
      'load',
      (event) => {
        if (
          event.target instanceof HTMLImageElement &&
          event.target.src.startsWith('blob:') &&
          event.target.closest(scroller)
        ) {
          mark('image-loaded', undefined, event.target.alt)
        }
      },
      true
    )
    document.addEventListener(
      'wheel',
      (event) => {
        if (!(event.target instanceof Element) || !event.target.closest(scroller)) return
        const at = performance.now()
        requestAnimationFrame(() => metrics.wheelFrames.push({ at, delay: performance.now() - at }))
      },
      { passive: true }
    )
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const frame = entry as PerformanceEntry & {
          blockingDuration: number
          scripts?: Array<{
            duration: number
            sourceFunctionName?: string
            sourceURL?: string
          }>
        }
        metrics.longFrames.push({
          at: frame.startTime,
          duration: frame.duration,
          blocking: frame.blockingDuration,
          scripts: (frame.scripts ?? []).map((script) => ({
            duration: script.duration,
            functionName: script.sourceFunctionName ?? '',
            url: script.sourceURL ?? ''
          }))
        })
      }
    }).observe({ type: 'long-animation-frame' })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number
          hadRecentInput: boolean
        }
        metrics.layoutShifts.push({
          at: shift.startTime,
          value: shift.value,
          hadRecentInput: shift.hadRecentInput
        })
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })

  await Promise.all([
    sendPrompt(page, 'Create the PDF chart preview fixtures.', 'PDF chart files published.'),
    (async () => {
      await viewport
        .getByRole('button', { name: 'Preview generated file dense-scatter-a.pdf', exact: true })
        .waitFor({ state: 'attached' })
      const bounds = await viewport.boundingBox()
      if (!bounds) return
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      const lastThumbnail = viewport.getByRole('img', { name: 'Preview of ordinary-scatter.pdf' })
      for (let i = 0; i < 48 && !(await lastThumbnail.isVisible()); i++) {
        await page.mouse.wheel(0, i % 2 ? 16 : -16)
      }
    })()
  ])
  for (const name of chartNames) {
    const card = viewport.getByRole('button', {
      name: `Preview generated file ${name}`,
      exact: true
    })
    await expect(card).toBeEnabled()
    const thumbnail = card.getByRole('img', { name: `Preview of ${name}` })
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0)
  }
  const metrics = await page.evaluate(
    () => (window as unknown as { pdfChartMetrics: unknown }).pdfChartMetrics
  )
  const timingFile = testInfo.outputPath('conversation-pdf-chart-timing.json')
  await writeFile(timingFile, JSON.stringify(metrics, null, 2))
  await testInfo.attach('conversation-pdf-chart-timing', {
    path: timingFile,
    contentType: 'application/json'
  })
  await viewport.getByRole('button', { name: 'Preview generated file dense-scatter-a.pdf' }).click()
  const original = page.locator('[data-single-page-pdf-preview]').getByRole('img', {
    name: 'dense-scatter-a.pdf'
  })
  await expect
    .poll(() => original.evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBeGreaterThan(0)
})
