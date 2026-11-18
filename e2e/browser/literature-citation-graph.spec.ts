import { expect, test, type Locator } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  citationGraphPath,
  openCitationGraph,
  verifyCitationDesktopLayout,
  verifyCitationPointerAndHistory,
  verifyCitationNarrowLayout,
  verifyCitationFocusAndClose
} from '../fixtures/citation-graph-interactions'

test('citation graph keeps the desktop canvas readable and paper list independent', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath)
  await page.screenshot({ path: info.outputPath('graph-desktop-initial.png') })
  await verifyCitationDesktopLayout(page)
  await page.screenshot({ path: info.outputPath('graph-desktop-selected.png') })
})

test('navigates relationship tabs with the keyboard', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath, undefined, 'all')
  const frame = page.locator('[data-current-frame="true"]')
  await frame.getByRole('tab', { name: 'All', exact: true }).focus()
  for (const [key, name] of [
    ['ArrowRight', 'References'],
    ['End', 'Cited by'],
    ['Home', 'All']
  ]) {
    await page.keyboard.press(key)
    const tab = frame.getByRole('tab', { name, exact: true })
    await expect(tab).toBeFocused()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(frame.getByRole('tabpanel', { name, exact: true })).toBeVisible()
    if (key === 'ArrowRight') await page.screenshot({ path: info.outputPath('graph-keyboard.png') })
  }
})

for (const width of [375, 1440]) {
  test(`keeps citation controls clear of the plot at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await openCitationGraph(page, citationGraphPath + '&dark')
    const frame = page.locator('[data-current-frame="true"]')
    const tabs = (await frame.locator('[data-citation-direction-tabs]').boundingBox())!
    const tools = (await frame.locator('[data-citation-toolbar]').boundingBox())!
    const plot = (await frame.locator('[data-citation-plot]').boundingBox())!
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(plot.y)
    if (width === 375) expect(tools.y).toBeGreaterThanOrEqual(plot.y + plot.height)
    else expect(tools.y + tools.height).toBeLessThanOrEqual(plot.y)
    const source = (await page.getByRole('combobox', { name: 'Citation source' }).boundingBox())!
    const view = (await page
      .getByRole('button', { name: 'Citation graph', exact: true })
      .boundingBox())!
    expect(Math.abs(source.y + source.height / 2 - view.y - view.height / 2)).toBeLessThan(4)
    expect(source.x - view.x - view.width).toBeLessThan(20)
    await frame.locator('[data-paper-id="europe-pmc:MED:1100"] [data-node-mark]').click()
    await expect(frame.locator('[data-citation-inspector-title]')).toContainText('Graph paper 1100')
    await page.mouse.move(0, 0)
    if (await frame.locator('[data-citation-hover-title]').count())
      await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath(`graph-${width}-dark-layout.png`) })
  })
}

for (const width of [320, 375, 414, 768]) {
  test(`citation sidebar keeps pagination with its papers at ${width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: 812 })
    await openCitationGraph(page, citationGraphPath)
    const frame = page.locator('[data-current-frame="true"]')
    const pane = frame.locator('[data-citation-inspector-pane]')
    const toggle = frame.locator('[data-citation-inspector-toggle]')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    const group = pane.getByRole('region', { name: 'References', exact: true })
    const more = group.getByRole('button', { name: 'Load more' })
    await expect(more).toBeInViewport({ ratio: 1 })
    const box = (await more.boundingBox())!
    expect(box.width).toBeLessThan(140)
    const groupBox = (await group.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(groupBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(groupBox.x + groupBox.width)
    await group.locator('[data-citation-paper-id]').last().scrollIntoViewIfNeeded()
    expect((await more.boundingBox())!.y).toBeCloseTo(box.y, 0)
    await expect(frame.locator('[data-citation-canvas] [data-citation-status]')).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await more.click()
    await expect(frame.locator('[data-paper-id="europe-pmc:MED:1139"]')).toHaveCount(1)
    await frame.locator('[data-paper-id="europe-pmc:MED:1100"] [data-node-mark]').click()
    await expect(frame.getByRole('button', { name: 'Open Inbox', exact: true })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Add to Inbox', exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    if (await frame.locator('[data-citation-hover-title]').count())
      await page.keyboard.press('Escape')
    await page.screenshot({ path: info.outputPath(`panel-${width}.png`) })
  })
}

test('citation graph pointer hits, pan, zoom and cached exploration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath)
  await verifyCitationPointerAndHistory(page)
})

for (const width of [375, 640]) {
  test(`citation graph keeps inspector actions usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 812 })
    await openCitationGraph(page, citationGraphPath)
    await verifyCitationNarrowLayout(page, async (state) => {
      await page.screenshot({ path: info.outputPath(`graph-${width}-${state}.png`) })
    })
  })
}

test('citation graph restores keyboard focus through the real detail dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath)
  await verifyCitationFocusAndClose(page)
})

test('complete paper titles remain hoverable and consume Escape before the detail dialog', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath)
  const frame = page.locator('[data-current-frame="true"]')
  const node = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
  const tooltip = frame.locator('[data-citation-hover-title]')
  await node.locator('[data-node-mark]').hover()
  await expect(tooltip).toBeVisible()
  await tooltip.hover()
  await page.waitForTimeout(180)
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(page.getByRole('dialog')).toBeVisible()
  await node.focus()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(node).toBeFocused()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const width of [1440, 375]) {
  test(`citation direction titles and selected arrows at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await openCitationGraph(page, citationGraphPath)
    const frame = page.locator('[data-current-frame="true"]')
    for (const [direction, id] of [
      ['references', 1100],
      ['citations', 1200]
    ] as const) {
      await frame.locator(`[data-citation-direction-tab="${direction}"]`).click()
      const node = frame.locator(`[data-paper-id="europe-pmc:MED:${id}"]`)
      const mark = node.locator('[data-node-mark]')
      await expect(mark).toBeVisible()
      const plot = await frame.locator('[data-citation-plot]').boundingBox()
      const box = await mark.boundingBox()
      expect(box!.x + box!.width / 2).toBeGreaterThan(plot!.x)
      expect(box!.x + box!.width / 2).toBeLessThan(plot!.x + plot!.width)
      expect(box!.y + box!.height / 2).toBeGreaterThan(plot!.y)
      expect(box!.y + box!.height / 2).toBeLessThan(plot!.y + plot!.height)
      await mark.click()
      await expect(node).toHaveAttribute('aria-pressed', 'true')
      const title = `Graph paper ${id}: a study with a deliberately long descriptive title`
      await expect(frame.locator('[data-citation-inspector-title]')).toHaveText(title)
      // The inspector resize can move another node under the pointer. Dismiss that
      // inspection before focusing the selected paper, as a keyboard user can do.
      await page.mouse.move(0, 0)
      await page.keyboard.press('Escape')
      await frame.getByRole('button', { name: 'Zoom in', exact: true }).focus()
      await node.focus()
      const selectedEdge = frame.locator(
        `path[data-edge-emphasis="related"][${direction === 'references' ? 'data-target' : 'data-source'}="europe-pmc:MED:${id}"]`
      )
      await expect(selectedEdge).toHaveCount(1)
      const colors = await selectedEdge.evaluate((element) => {
        const marker = element.getAttribute('marker-end')!.slice(5, -1)
        return {
          line: getComputedStyle(element).stroke,
          arrow: getComputedStyle(document.getElementById(marker)!.querySelector('path')!).fill,
          primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
        }
      })
      expect(colors.arrow).toBe(colors.line)
      expect(await mark.evaluate((element) => getComputedStyle(element).fill)).toBe(colors.line)
      expect(colors.primary).toBeTruthy()
      await expect(frame.locator('[data-citation-hover-title]')).toHaveText(title)
      await page.screenshot({
        path: info.outputPath(`graph-${width}-${direction}-selected-title.png`)
      })
      await page.keyboard.press('Escape')
      await expect(frame.locator('[data-citation-hover-title]')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(node).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: info.outputPath(`graph-${width}-${direction}-selected.png`) })
      if (width === 375) {
        const details = frame.locator('[data-citation-inspector-toggle]')
        await details.click()
        await expect(details).toHaveAttribute('aria-expanded', 'false')
        await expect(node).toHaveAttribute('aria-pressed', 'true')
        if (await frame.locator('[data-citation-hover-title]').count()) {
          await page.keyboard.press('Escape')
          await expect(frame.locator('[data-citation-hover-title]')).toHaveCount(0)
          await expect(page.getByRole('dialog')).toBeVisible()
        }
        await expect
          .poll(async () => {
            const size = await node.locator('text').evaluate((element) => {
              const text = element as SVGTextElement
              const matrix = text.getScreenCTM()!
              return parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.c, matrix.d)
            })
            return Math.abs(size - 12)
          })
          .toBeLessThan(0.5)
        await page.screenshot({ path: info.outputPath(`graph-${width}-${direction}-compact.png`) })
        // Keep the original regression trigger: switch direction with the inspector expanded.
        await details.click()
        await expect(details).toHaveAttribute('aria-expanded', 'true')
      }
    }
  })
}

for (const width of [1440, 375]) {
  test(`fits citations after empty references at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await openCitationGraph(page, `${citationGraphPath}&empty-references`)
    const frame = page.locator('[data-current-frame="true"]')
    await expect(frame.locator('[data-paper-id]')).toHaveCount(1)
    await frame.locator('[data-citation-direction-tab="citations"]').click()
    await expect(frame.locator('[data-paper-id]')).toHaveCount(21)
    const plot = await frame.locator('[data-citation-plot]').boundingBox()
    const mark = frame.locator('[data-paper-id="europe-pmc:MED:1200"] [data-node-mark]')
    await expect
      .poll(async () => {
        const box = await mark.boundingBox()
        return (
          !!box &&
          box.x >= plot!.x &&
          box.y >= plot!.y &&
          box.x + box.width <= plot!.x + plot!.width &&
          box.y + box.height <= plot!.y + plot!.height
        )
      })
      .toBe(true)
    await mark.click()
    await expect(frame.locator('[data-paper-id="europe-pmc:MED:1200"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
}

for (const height of [812, 667]) {
  test(`375px expanded details leave a usable graph at ${height}px tall`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width: 375, height })
    await openCitationGraph(page, citationGraphPath)
    const frame = page.locator('[data-current-frame="true"]')
    const pane = frame.locator('[data-citation-inspector-pane]')
    const canvas = frame.locator('[data-citation-canvas]')
    const plot = frame.locator('[data-citation-plot]')
    for (const [direction, id] of [
      ['references', 1100],
      ['citations', 1200]
    ] as const) {
      await frame.locator(`[data-citation-direction-tab="${direction}"]`).click()
      const node = frame.locator(`[data-paper-id="europe-pmc:MED:${id}"]`)
      await node.locator('[data-node-mark]').click()
      await expect(node).toHaveAttribute('aria-pressed', 'true')
      await expect(pane).toHaveAttribute('data-expanded', 'true')
      await page.mouse.move(0, 0)
      const tooltip = frame.locator('[data-citation-hover-title]')
      await expect(tooltip).toHaveCount(0)
      await expect
        .poll(async () => (await plot.boundingBox())!.height)
        .toBeGreaterThanOrEqual(height === 812 ? 180 : 95)
      await expect
        .poll(async () => {
          const size = await node.locator('text').evaluate((element) => {
            const text = element as SVGTextElement
            const matrix = text.getScreenCTM()!
            return parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.c, matrix.d)
          })
          return Math.abs(size - 12)
        })
        .toBeLessThan(0.5)
      const graphBounds = (await canvas.boundingBox())!
      const detailsBounds = (await pane.boundingBox())!
      expect(graphBounds.height).toBeGreaterThan(detailsBounds.height)
      await expect(frame.locator('[data-citation-inspector-title]')).toBeVisible()
      await page.screenshot({
        path: info.outputPath(`graph-375x${height}-${direction}-expanded.png`)
      })
      const scroll = frame.locator('[data-citation-inspector]')
      await scroll.locator('summary').click()
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      expect((await canvas.boundingBox())!.height).toBeCloseTo(graphBounds.height, 0)
      for (const name of ['Set as center', 'Add to Inbox']) {
        await frame.getByRole('button', { name, exact: true }).click({ trial: true })
      }
      await expect(node).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({
        path: info.outputPath(`graph-375x${height}-${direction}-scrolled.png`)
      })
      // Close the long abstract before checking the next paper.
      await scroll.evaluate((element) => {
        element.scrollTop = 0
      })
      await scroll.locator('summary').click()
    }
  })
}

for (const [height, language, landscape] of [
  [568, 'en', false],
  [667, 'fr', false],
  [667, 'de', false],
  [667, 'en', true]
] as const) {
  test(`short details keep failed-save actions reachable at ${landscape ? '812x375 landscape' : `375x${height}`} (${language} content)`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width: 375, height })
    await openCitationGraph(page, `${citationGraphPath}&citation-save=failure`)
    const frame = page.locator('[data-current-frame="true"]')
    const pane = frame.locator('[data-citation-inspector-pane]')
    const body = pane.locator('[data-citation-inspector]')
    const actions = pane.locator('[data-citation-inspector-actions]')
    const svg = frame.locator('svg[data-zoom]')
    const first = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
    await first.locator('[data-node-mark]').click()
    async function finishSave(expected: string): Promise<void> {
      await page.evaluate(() => {
        delete (window as unknown as { finishCitationStage?: () => void }).finishCitationStage
      })
      await actions.getByRole('button', { name: 'Add to Inbox', exact: true }).click()
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              typeof (window as unknown as { finishCitationStage?: () => void }).finishCitationStage
          )
        )
        .toBe('function')
      await page.evaluate(() =>
        (window as unknown as { finishCitationStage: () => void }).finishCitationStage()
      )
      await expect(actions.getByRole('status')).toHaveText(expected)
    }
    await finishSave('In Inbox')
    await first.focus()
    await page.keyboard.press('ArrowDown')
    const selected = frame.locator('[data-paper-id="europe-pmc:MED:1101"]')
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await finishSave('Could not add this reference. Try again.')
    if (landscape) await page.setViewportSize({ width: 812, height: 375 })
    const translations: Record<string, string> =
      language === 'en'
        ? {}
        : JSON.parse(readFileSync(`src/shared/i18n/locales/${language}.json`, 'utf8')).renderer
    if (language !== 'en') {
      // Content pressure using real catalog strings; this is not an application language switch.
      await actions.evaluate((element, translations) => {
        for (const text of element.querySelectorAll('button, [role="status"]')) {
          const key = text.textContent!.trim()
          if (translations[key]) text.textContent = translations[key]
        }
      }, translations)
    }
    const camera = await svg.getAttribute('viewBox')
    const graphHeight = (await frame.locator('[data-citation-canvas]').boundingBox())!.height
    await expect
      .poll(() => body.evaluate((element) => element.clientHeight))
      .toBeGreaterThanOrEqual(96)
    // Start at the title, then scroll over the actual body. At its edge the wheel must
    // continue into the fallback pane, rather than being trapped by overscroll containment.
    await pane.evaluate((element) => {
      element.scrollTop = 0
    })
    await body.evaluate((element) => {
      element.scrollTop = 0
    })
    const pointer = await body.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const region = element.closest('[data-citation-inspector-pane]')!.getBoundingClientRect()
      return {
        x: box.x + 8,
        y: (Math.max(box.top, region.top) + Math.min(box.bottom, region.bottom)) / 2
      }
    })
    await page.mouse.move(pointer.x, pointer.y)
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(actions.getByRole('status')).toBeInViewport({ ratio: 1 })
    for (const source of ['Set as center', 'Add to Inbox']) {
      const button = actions.getByRole('button', {
        name: translations[source] ?? source,
        exact: true
      })
      const box = (await button.boundingBox())!
      const region = (await pane.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(region.y)
      expect(box.y + box.height).toBeLessThanOrEqual(region.y + region.height + 1)
      await button.click({ trial: true })
    }
    await expect(svg).toHaveAttribute('viewBox', camera!)
    expect((await frame.locator('[data-citation-canvas]').boundingBox())!.height).toBeCloseTo(
      graphHeight,
      0
    )
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({
      path: info.outputPath(
        `graph-${landscape ? '812x375' : `375x${height}`}-${language}-failure-actions.png`
      )
    })
    await pane.evaluate((element) => {
      element.scrollTop = 0
    })
    await body.locator('summary').click()
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await pane.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const openInbox = pane.getByRole('button', { name: 'Open Inbox', exact: true })
    await openInbox.scrollIntoViewIfNeeded()
    await expect(openInbox).toBeInViewport({ ratio: 1 })
    await openInbox.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('#inbox-state-pending')).toHaveAttribute('aria-selected', 'true')
  })
}

test('reselecting the current paper from a scrolled list restores its visible focused title', async ({
  page
}, info) => {
  await page.setViewportSize({ width: 375, height: 568 })
  await openCitationGraph(page, citationGraphPath)
  const frame = page.locator('[data-current-frame="true"]')
  const pane = frame.locator('[data-citation-inspector-pane]')
  const body = pane.locator('[data-citation-inspector]')
  const svg = frame.locator('svg[data-zoom]')
  const first = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
  await first.focus()
  await page.keyboard.press('End')
  const selected = frame.locator('[data-paper-id="europe-pmc:MED:1119"]')
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  const camera = await svg.getAttribute('viewBox')
  const list = pane.locator('[data-citation-paper-list-toggle]')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  const option = body.locator('ol button[aria-pressed="true"]')
  await expect(option).toContainText('Graph paper 1119:')
  await option.scrollIntoViewIfNeeded()
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await option.click()
  await body.getByRole('button', { name: 'View details' }).click()
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  const title = pane.locator('[data-citation-inspector-title]')
  await expect(title).toBeFocused()
  await expect(title).toHaveText(
    'Graph paper 1119: a study with a deliberately long descriptive title'
  )
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0)
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(title).toBeInViewport({ ratio: 1 })
  const box = (await title.boundingBox())!
  for (const region of [pane, body]) {
    const area = (await region.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(area.y)
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height)
  }
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  await expect(svg).toHaveAttribute('viewBox', camera!)
  await page.screenshot({ path: info.outputPath('graph-375x568-same-paper-focus-restored.png') })
})

for (const width of [1440, 375]) {
  test(`all relationships radiate around the original paper and share a filtered view at ${width}px`, async ({
    page
  }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await openCitationGraph(page, citationGraphPath, undefined, 'all')
    const frame = page.locator('[data-current-frame="true"]')
    const tab = (filter: string): Locator =>
      frame.locator(`[data-citation-direction-tab="${filter}"]`)
    const svg = frame.locator('svg[data-zoom]')
    const reference = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
    const citation = frame.locator('[data-paper-id="europe-pmc:MED:1200"]')
    await expect(tab('all')).toHaveAttribute('aria-selected', 'true')
    await expect(frame.locator('[data-paper-id]')).toHaveCount(41)
    await expect(frame.locator('path[data-source][data-target]')).toHaveCount(40)
    const layout = await frame.locator('[data-paper-id] [data-node-mark]').evaluateAll((marks) =>
      marks.map((mark) => ({
        x: Number(mark.getAttribute('data-x')),
        y: Number(mark.getAttribute('data-y')),
        relation: mark.closest('[data-paper-id]')!.getAttribute('data-relation')
      }))
    )
    expect(new Set(layout.map(({ x, y }) => `${x}:${y}`)).size).toBe(41)
    for (const relation of ['references', 'citations']) {
      const group = layout.filter((point) => point.relation === relation)
      expect(group.some((point) => point.x < 800)).toBe(true)
      expect(group.some((point) => point.x > 800)).toBe(true)
      expect(group.some((point) => point.y < 500)).toBe(true)
      expect(group.some((point) => point.y > 500)).toBe(true)
    }
    await reference.locator('[data-node-mark]').click()
    await expect(reference).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(0, 0)
    const title = frame.locator('[data-citation-hover-title]')
    if (await title.count()) {
      await page.keyboard.press('Escape')
      await expect(title).toHaveCount(0)
    }
    await expect
      .poll(async () =>
        reference.locator('text').evaluate((element) => {
          const text = element as SVGTextElement
          const m = text.getScreenCTM()!
          return Math.abs(parseFloat(getComputedStyle(text).fontSize) * Math.hypot(m.c, m.d) - 12)
        })
      )
      .toBeLessThan(0.5)
    const camera = await svg.getAttribute('viewBox')
    const position = (await reference.locator('[data-node-mark]').boundingBox())!
    const highlighted = frame.locator(
      'path[data-source="europe-pmc:MED:1000"][data-target="europe-pmc:MED:1100"]'
    )
    await expect(highlighted).toHaveAttribute('data-edge-emphasis', 'related')
    const colors = await highlighted.evaluate((element) => {
      const markerId = element.getAttribute('marker-end')!.slice(5, -1)
      return {
        line: getComputedStyle(element).stroke,
        arrow: getComputedStyle(document.getElementById(markerId)!.querySelector('path')!).fill
      }
    })
    expect(colors.arrow).toBe(colors.line)
    expect(
      await reference
        .locator('[data-node-mark]')
        .evaluate((element) => getComputedStyle(element).fill)
    ).toBe(colors.line)
    await page.screenshot({
      path: info.outputPath(`graph-all-${width}-selected-reference.png`),
      animations: 'disabled'
    })
    await tab('references').click()
    await expect(frame.locator('[data-paper-id]')).toHaveCount(21)
    await expect(reference).toHaveAttribute('aria-pressed', 'true')
    await expect(svg).toHaveAttribute('viewBox', camera!)
    const filteredPosition = (await reference.locator('[data-node-mark]').boundingBox())!
    // SVG bounds can round fractional CSS pixels differently after a resize measurement.
    // Compare painted centers within one CSS pixel; world coordinates and viewBox stay exact.
    expect(
      Math.abs(filteredPosition.x + filteredPosition.width / 2 - position.x - position.width / 2)
    ).toBeLessThan(1)
    expect(
      Math.abs(filteredPosition.y + filteredPosition.height / 2 - position.y - position.height / 2)
    ).toBeLessThan(1)
    await tab('all').click()
    await expect(reference).toHaveAttribute('aria-pressed', 'true')
    await expect(frame.locator('[data-paper-id]')).toHaveCount(41)
    await tab('citations').click()
    await expect(reference).toHaveCount(0)
    await expect(frame.locator('[data-paper-id="europe-pmc:MED:1000"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await citation.locator('[data-node-mark]').click()
    await expect(citation).toHaveAttribute('aria-pressed', 'true')
    await tab('all').click()
    await expect(citation).toHaveAttribute('aria-pressed', 'true')
    await expect(tab('all')).toHaveAttribute('aria-selected', 'true')
    await expect(tab('citations')).toHaveAttribute('aria-selected', 'false')
    await expect(frame.locator('[data-paper-id]')).toHaveCount(41)
    await page.mouse.move(0, 0)
    await expect(
      frame.locator('path[data-source="europe-pmc:MED:1200"][data-target="europe-pmc:MED:1000"]')
    ).toHaveAttribute('data-edge-emphasis', 'related')
    if (await title.count()) {
      await page.keyboard.press('Escape')
      await expect(title).toHaveCount(0)
    }
    await page.screenshot({
      path: info.outputPath(`graph-all-${width}-selected-citation.png`),
      animations: 'disabled'
    })
  })
}

test('all relationships merge a mutual paper while retaining both actual arrow directions', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, `${citationGraphPath}&mutual-paper`, undefined, 'all')
  const frame = page.locator('[data-current-frame="true"]')
  const paper = frame.locator('[data-paper-id="europe-pmc:MED:1100"]')
  await expect(frame.locator('[data-paper-id]')).toHaveCount(40)
  await expect(frame.locator('[data-relation="both"]')).toHaveCount(1)
  await expect(frame.locator('path[data-source][data-target]')).toHaveCount(40)
  await paper.locator('[data-node-mark]').click()
  await expect(paper).toHaveAttribute('aria-pressed', 'true')
  const outgoing = frame.locator(
    'path[data-source="europe-pmc:MED:1000"][data-target="europe-pmc:MED:1100"]'
  )
  const incoming = frame.locator(
    'path[data-source="europe-pmc:MED:1100"][data-target="europe-pmc:MED:1000"]'
  )
  for (const edge of [outgoing, incoming])
    await expect(edge).toHaveAttribute('data-edge-emphasis', 'related')
  expect(await outgoing.getAttribute('d')).not.toBe(await incoming.getAttribute('d'))
  for (const [filter, shown, hidden] of [
    ['references', outgoing, incoming],
    ['citations', incoming, outgoing]
  ] as const) {
    await frame.locator(`[data-citation-direction-tab="${filter}"]`).click()
    await expect(paper).toHaveCount(1)
    await expect(paper).toHaveAttribute('aria-pressed', 'true')
    await expect(shown).toHaveCount(1)
    await expect(hidden).toHaveCount(0)
  }
})

test('keeps sidebar category tabs fixed and removes the collapsed rail', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openCitationGraph(page, citationGraphPath, undefined, 'all')
  const frame = page.locator('[data-current-frame="true"]')
  const inspector = frame.locator('[data-citation-inspector-pane]')
  const tabs = inspector.getByRole('tablist', { name: 'Paper list' })
  const references = tabs.getByRole('tab', { name: /^References/ })
  const citing = tabs.getByRole('tab', { name: /^Cited by/ })
  const body = inspector.locator('[data-citation-inspector]')
  const before = (await tabs.boundingBox())!
  await body.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  expect((await tabs.boundingBox())!.y).toBe(before.y)
  const saved = await body.evaluate((el) => el.scrollTop)
  await citing.click()
  await expect(inspector.getByRole('region', { name: 'References', exact: true })).toHaveCount(0)
  await expect(inspector.getByRole('region', { name: 'Papers citing this paper' })).toBeVisible()
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(0)
  await references.focus()
  await page.keyboard.press('Enter')
  await expect(references).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(saved)
  await page.screenshot({ path: info.outputPath('sidebar-fixed-tabs.png') })
  const canvas = frame.locator('[data-citation-canvas]')
  const width = (await canvas.boundingBox())!.width
  await frame.getByRole('button', { name: 'Collapse sidebar panel' }).click()
  await expect(inspector).toBeHidden()
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(width + 300)
  const expandedCanvas = (await canvas.boundingBox())!
  const workspace = (await frame.locator('[data-citation-workspace]').boundingBox())!
  expect(
    Math.abs(expandedCanvas.x + expandedCanvas.width - workspace.x - workspace.width)
  ).toBeLessThan(2)
  await page.screenshot({ path: info.outputPath('sidebar-fully-collapsed.png') })
  await frame.getByRole('button', { name: 'Expand sidebar panel' }).click()
  await expect(inspector).toBeVisible()
  await expect(references).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(saved)
})
