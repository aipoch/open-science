import { expect, type Locator, type Page } from '@playwright/test'

export const citationGraphPath = '/literature-recovery.html?mode=files&citation-graph'
const rootTitle = 'A reference with supporting PDFs'
const paperTitle = (id: number): string =>
  `Graph paper ${id}: a study with a deliberately long descriptive title`
const currentFrame = (page: Page): Locator => page.locator('[data-current-frame="true"]')
const node = (page: Page, id: number): Locator =>
  currentFrame(page).locator(`[data-paper-id="europe-pmc:MED:${id}"]`)

async function bounds(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!
}

async function clickMark(page: Page, id: number): Promise<void> {
  const mark = await bounds(node(page, id).locator('[data-node-mark]'))
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2)
  await expect(node(page, id)).toHaveAttribute('aria-pressed', 'true')
  await expect(
    currentFrame(page).getByRole('heading', { name: paperTitle(id), exact: true })
  ).toBeVisible()
}

async function requestCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          literatureFiles: { requests: Array<{ direction?: string }> }
        }
      ).literatureFiles.requests.filter((request) => request.direction).length
  )
}

async function expectReadableSelectedLabel(page: Page): Promise<void> {
  const label = currentFrame(page).locator('[data-paper-id][aria-pressed="true"] text')
  await expect(label).toBeVisible()
  const painted = await label.evaluate((element) => {
    const text = element as SVGTextElement
    const matrix = text.getScreenCTM()!
    const style = getComputedStyle(text)
    return {
      size: parseFloat(style.fontSize) * Math.hypot(matrix.c, matrix.d),
      opacity: Number(style.opacity)
    }
  })
  expect(Number(painted.size.toFixed(2))).toBeGreaterThanOrEqual(11)
  expect(painted.opacity).toBe(1)
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [data-current-frame="true"], [data-citation-workspace]'
      )
    ).map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        selector: element.getAttribute('data-current-frame')
          ? 'current frame'
          : element.getAttribute('data-citation-workspace') !== null
            ? 'citation workspace'
            : 'dialog',
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth
      }
    })
  )
  expect(overflow.length).toBeGreaterThan(0)
  for (const element of overflow) {
    expect(
      element.scrollWidth - element.clientWidth,
      `${element.selector} overflow`
    ).toBeLessThanOrEqual(1)
    expect(element.right, `${element.selector} is outside the viewport`).toBeLessThanOrEqual(
      element.viewportWidth + 1
    )
  }
}

export async function verifyCitationDirectionTabs(page: Page): Promise<void> {
  const tabs = currentFrame(page).locator('[data-citation-direction-tabs]')
  await expect(tabs).toBeVisible()
  const all = tabs.locator('[data-citation-direction-tab="all"]')
  const references = tabs.locator('[data-citation-direction-tab="references"]')
  const citations = tabs.locator('[data-citation-direction-tab="citations"]')
  await expect(all).toHaveRole('tab')
  await expect(all).toHaveText('All')
  await expect(references).toHaveRole('tab')
  await expect(citations).toHaveRole('tab')
  await expect(references).toHaveText('References')
  await expect(citations).toHaveText('Cited by')
  for (const tab of [all, references, citations]) {
    const box = await bounds(tab)
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(28)
    await expect(tab).toBeVisible()
  }
  await expect
    .poll(() =>
      tabs.evaluate((list) => {
        const active = list.querySelector('[aria-selected="true"]')
        const inactive = list.querySelector('[aria-selected="false"]')
        if (!active || !inactive) return false
        const a = getComputedStyle(active)
        const b = getComputedStyle(inactive)
        return a.backgroundColor !== b.backgroundColor || a.color !== b.color
      })
    )
    .toBe(true)
}

type CitationEdgeState = 'ordinary' | 'selected' | 'citations' | 'selected-citations'

type CitationEdgeSnapshot = {
  source: string
  target: string
  direction: string | null
  markerEnd: string | null
  opacity: number
}

const edge = (page: Page, source: number, target: number): Locator =>
  currentFrame(page).locator(
    `path[data-source="europe-pmc:MED:${source}"][data-target="europe-pmc:MED:${target}"]`
  )

async function edgeSnapshots(page: Page): Promise<CitationEdgeSnapshot[]> {
  return currentFrame(page)
    .locator('svg[role="group"] path[data-source][data-target]')
    .evaluateAll((paths) =>
      paths.map((path) => ({
        source: path.getAttribute('data-source')!,
        target: path.getAttribute('data-target')!,
        direction: path.getAttribute('data-direction'),
        markerEnd: path.getAttribute('marker-end'),
        opacity: Number(path.getAttribute('opacity'))
      }))
    )
}

export async function verifyCitationEdgeRendering(
  page: Page,
  onState?: (state: CitationEdgeState) => Promise<void>
): Promise<void> {
  const center = 'europe-pmc:MED:1000'
  const reference = edge(page, 1000, 1100)
  const citation = edge(page, 1200, 1000)
  const referencesTab = currentFrame(page).locator('[data-citation-direction-tab="references"]')
  const citationsTab = currentFrame(page).locator('[data-citation-direction-tab="citations"]')
  await verifyCitationDirectionTabs(page)
  await expect(referencesTab).toHaveAttribute('role', 'tab')
  await expect(referencesTab).toHaveAttribute('aria-selected', 'true')
  await expect(citationsTab).toHaveAttribute('aria-selected', 'false')
  await expect(reference).toHaveCount(1)
  await expect(citation).toHaveCount(0)

  const referenceColor = await reference.evaluate((path) => getComputedStyle(path).stroke)
  const referenceMark = node(page, 1100).locator('[data-node-mark]')
  expect(await referenceMark.evaluate((mark) => getComputedStyle(mark).stroke)).toBe(referenceColor)
  expect(
    await currentFrame(page)
      .locator('[data-citation-legend] .bg-chart-1')
      .evaluate((swatch) => getComputedStyle(swatch).backgroundColor)
  ).toBe(referenceColor)
  const ordinary = await edgeSnapshots(page)
  expect(ordinary.length).toBeGreaterThanOrEqual(2)
  for (const path of ordinary) {
    expect(path.source).toMatch(/^europe-pmc:MED:\d+$/)
    expect(path.target).toMatch(/^europe-pmc:MED:\d+$/)
    expect(path.direction).toBe('references')
    expect(path.source).toBe(center)
    expect(path.markerEnd).toContain(`-${path.direction})`)
    expect(path.opacity).toBeGreaterThan(0)
  }
  expect(await reference.getAttribute('data-source')).toBe(center)
  expect(await reference.getAttribute('data-target')).toBe('europe-pmc:MED:1100')
  expect(await reference.getAttribute('data-direction')).toBe('references')
  await onState?.('ordinary')

  await clickMark(page, 1100)
  const selected = await edgeSnapshots(page)
  const selectedReference = selected.find(
    (path) => path.source === center && path.target === 'europe-pmc:MED:1100'
  )
  const unrelatedReference = selected.find(
    (path) => path.source === center && path.target === 'europe-pmc:MED:1101'
  )
  expect(selectedReference).toBeDefined()
  expect(unrelatedReference).toBeDefined()
  expect(selectedReference!.opacity).toBeGreaterThan(unrelatedReference!.opacity)
  expect(selectedReference!.markerEnd).toContain('-references-emphasized)')
  expect(selectedReference!.source).toBe(center)
  expect(selectedReference!.target).toBe('europe-pmc:MED:1100')
  expect(unrelatedReference!.source).toBe(center)
  expect(unrelatedReference!.target).toBe('europe-pmc:MED:1101')
  await onState?.('selected')

  await citationsTab.click()
  await verifyCitationDirectionTabs(page)
  await expect(citationsTab).toHaveAttribute('aria-selected', 'true')
  await expect(referencesTab).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('[data-citation-center-title]')).toHaveText(rootTitle)
  await expect(citation).toHaveCount(1)
  await expect(reference).toHaveCount(0)
  const citationColor = await citation.evaluate((path) => getComputedStyle(path).stroke)
  expect(citationColor).not.toBe(referenceColor)
  expect(
    await node(page, 1200)
      .locator('[data-node-mark]')
      .evaluate((mark) => getComputedStyle(mark).stroke)
  ).toBe(citationColor)
  expect(
    await currentFrame(page)
      .locator('[data-citation-legend] .bg-chart-3')
      .evaluate((swatch) => getComputedStyle(swatch).backgroundColor)
  ).toBe(citationColor)
  const citationEdges = await edgeSnapshots(page)
  expect(citationEdges.length).toBeGreaterThanOrEqual(2)
  for (const path of citationEdges) {
    expect(path.direction).toBe('citations')
    expect(path.target).toBe(center)
    expect(path.markerEnd).toContain('-citations)')
  }
  expect(await citation.getAttribute('data-source')).toBe('europe-pmc:MED:1200')
  expect(await citation.getAttribute('data-target')).toBe(center)
  expect(await citation.getAttribute('data-direction')).toBe('citations')
  await onState?.('citations')

  await clickMark(page, 1200)
  const selectedCitations = await edgeSnapshots(page)
  const selectedCitation = selectedCitations.find(
    (path) => path.source === 'europe-pmc:MED:1200' && path.target === center
  )
  const unrelatedCitation = selectedCitations.find(
    (path) => path.source === 'europe-pmc:MED:1201' && path.target === center
  )
  expect(selectedCitation).toBeDefined()
  expect(unrelatedCitation).toBeDefined()
  expect(selectedCitation!.opacity).toBeGreaterThan(unrelatedCitation!.opacity)
  expect(selectedCitation!.direction).toBe('citations')
  expect(selectedCitation!.markerEnd).toContain('-citations-emphasized)')
  expect(await page.locator('[data-citation-center-title]')).toHaveText(rootTitle)
  await onState?.('selected-citations')

  await referencesTab.click()
  await verifyCitationDirectionTabs(page)
  await expect(referencesTab).toHaveAttribute('aria-selected', 'true')
  await expect(citationsTab).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('[data-citation-center-title]')).toHaveText(rootTitle)
  await expect(reference).toHaveCount(1)
  await expect(citation).toHaveCount(0)

  // Direction changes must not replace the exploration frame or its history.
  await clickMark(page, 1100)
  await currentFrame(page).getByRole('button', { name: 'Set as center', exact: true }).click()
  const childTitle = page.locator('[data-citation-center-title]')
  await expect(childTitle).toHaveText(paperTitle(1100))
  const childCitationsTab = currentFrame(page).locator('[data-citation-direction-tab="citations"]')
  await childCitationsTab.click()
  await expect(childCitationsTab).toHaveAttribute('aria-selected', 'true')
  await expect(
    currentFrame(page).locator('svg[role="group"] path[data-direction="citations"]')
  ).toHaveCount(20)
  await expect(childTitle).toHaveText(paperTitle(1100))
  await page.getByRole('button', { name: 'Back', exact: true }).filter({ hasText: 'Back' }).click()
  await expect(page.locator('[data-citation-center-title]')).toHaveText(rootTitle)
}

export async function verifyCitationDesktopLayout(
  page: Page,
  onListSelection?: () => Promise<void>
): Promise<void> {
  const frame = currentFrame(page)
  const inspector = frame.locator('[data-citation-inspector-pane]')
  const details = frame.locator('[data-citation-inspector-toggle]')
  const list = frame.locator('[data-citation-paper-list-toggle]')
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  await expect(inspector.getByRole('region', { name: 'Paper list', exact: true })).toBeVisible()
  await expect(frame.locator('[data-citation-canvas] [data-citation-status]')).toHaveCount(0)
  await verifyCitationDirectionTabs(page)
  await expectNoHorizontalOverflow(page)
  const canvas = await bounds(frame.locator('[data-citation-canvas]'))
  const panel = await bounds(page.getByRole('dialog'))
  const sidebar = await bounds(inspector)
  expect(sidebar.x).toBeGreaterThanOrEqual(canvas.x + canvas.width - 1)
  expect(canvas.height).toBeGreaterThanOrEqual(panel.height / 2)

  await clickMark(page, 1100)
  await expectReadableSelectedLabel(page)
  await expect(frame.locator('[data-citation-inspector-title]')).toBeVisible()
  const actions = frame.locator('[data-citation-inspector-actions]')
  await expect(actions).toBeVisible()
  const panelBox = await bounds(inspector)
  for (const name of ['Set as center', 'Add to Inbox']) {
    const action = frame.getByRole('button', { name, exact: true })
    await expect(action).toBeVisible()
    const box = await bounds(action)
    expect(box.x).toBeGreaterThanOrEqual(panelBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
  }
  await expectNoHorizontalOverflow(page)
  await expect(list).toHaveText('Back to list')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  const listedPaper = inspector
    .locator('[data-citation-paper-id]')
    .filter({ hasText: paperTitle(1101) })
  const more = inspector.getByRole('button', { name: 'Load more' })
  await expect(more).toBeInViewport({ ratio: 1 })
  await expect(more.locator('svg')).toHaveCount(0)
  await expect(inspector.getByRole('button', { name: 'Open Inbox' })).toHaveCount(0)
  await listedPaper.click()
  await expect(node(page, 1101)).toHaveAttribute('aria-pressed', 'true')
  await expect(listedPaper).toHaveAttribute('aria-pressed', 'true')
  await expect(actions).toHaveCount(0)
  await onListSelection?.()
  const body = inspector.locator('[data-citation-inspector]')
  // Locator.click scrolls a sticky footer's normal-flow box into view before mousedown.
  // Click its visible position so the page-load assertion measures a real pointer interaction.
  await expect(more).toBeInViewport({ ratio: 1 })
  const button = await bounds(more)
  const scroll = await body.evaluate((element) => element.scrollTop)
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)
  await expect(node(page, 1139)).toHaveCount(1)
  await expect(body).toHaveJSProperty('scrollTop', scroll)
  await expect(listedPaper).toHaveAttribute('aria-pressed', 'true')
  await inspector.getByRole('button', { name: 'View details' }).click()
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  await expect(
    inspector.getByRole('heading', { name: paperTitle(1101), exact: true })
  ).toBeVisible()
  await expect(
    inspector.getByText(
      'Metadata supplied by the browser fixture, with no external provider requests.'
    )
  ).toBeVisible()
  await expect(frame.locator('[data-citation-inspector-title]')).toBeFocused()
  await expectReadableSelectedLabel(page)
  await expectNoHorizontalOverflow(page)
  await list.click()
  await page.keyboard.press('Escape')
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  await expect(list).toBeFocused()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('dialog')).toBeVisible()
}

export async function openCitationGraph(
  page: Page,
  url: string,
  beforeOpen?: () => Promise<void>,
  initialFilter: 'all' | 'references' | 'citations' = 'references'
): Promise<void> {
  await page.goto(url)
  await beforeOpen?.()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
  await page.getByRole('button', { name: rootTitle, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'References', exact: true }).click()
  await dialog.getByRole('button', { name: 'Citation graph', exact: true }).click()
  await expect(node(page, 1000)).toBeVisible()
  await expect(currentFrame(page).getByText('Searching…', { exact: true })).toHaveCount(0)
  await expect(currentFrame(page).locator('[data-citation-direction-tab="all"]')).toHaveAttribute(
    'aria-selected',
    'true'
  )
  if (initialFilter !== 'all') {
    await currentFrame(page).locator(`[data-citation-direction-tab="${initialFilter}"]`).click()
  }
}

export async function verifyCitationPointerAndHistory(page: Page): Promise<void> {
  const frame = currentFrame(page)
  const canvas = frame.locator('[data-citation-canvas]')
  const svg = canvas.locator('svg[role="group"]')
  await clickMark(page, 1100)
  const selected = node(page, 1100)
  const before = await bounds(selected.locator('[data-node-mark]'))
  const area = await bounds(canvas)
  await page.mouse.move(area.x + 8, area.y + 8)
  await page.mouse.down()
  await page.mouse.move(area.x + 78, area.y + 48, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Number(await svg.getAttribute('data-pan-x'))).toBeCloseTo(70, 2)
  await expect.poll(async () => Number(await svg.getAttribute('data-pan-y'))).toBeCloseTo(40, 2)
  const after = await bounds(selected.locator('[data-node-mark]'))
  expect(after.x - before.x).toBeCloseTo(70, 0)
  expect(after.y - before.y).toBeCloseTo(40, 0)
  await expect(selected).toHaveAttribute('aria-pressed', 'true')

  // Zoom around the pointer, including after dragging and at non-100% Electron zoom.
  const anchor = await bounds(selected.locator('[data-node-mark]'))
  const pointer = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }
  await page.mouse.move(pointer.x, pointer.y)
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => Number(await svg.getAttribute('data-zoom'))).toBeGreaterThan(1)
  const anchored = await bounds(selected.locator('[data-node-mark]'))
  expect(anchored.x + anchored.width / 2).toBeCloseTo(pointer.x, 0)
  expect(anchored.y + anchored.height / 2).toBeCloseTo(pointer.y, 0)
  expect(anchored.width).toBeGreaterThan(anchor.width)
  await page.mouse.wheel(0, 10000)
  await expect(svg).toHaveAttribute('data-zoom', '0.5')
  await page.mouse.wheel(0, -10000)
  await expect(svg).toHaveAttribute('data-zoom', '3')
  const viewportWidth = await page.evaluate(() => innerWidth)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 100)
  await page.keyboard.up('Control')
  await expect.poll(async () => Number(await svg.getAttribute('data-zoom'))).toBeLessThan(3)
  expect(await page.evaluate(() => innerWidth)).toBe(viewportWidth)
  await frame.getByRole('button', { name: 'Fit graph', exact: true }).first().click()
  await expect(svg).toHaveAttribute('data-zoom', '1')

  await frame.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(svg).toHaveAttribute('data-zoom', '1.2')
  const zoomed = await bounds(selected.locator('[data-node-mark]'))
  expect(zoomed.width).toBeGreaterThan(after.width)
  await frame.locator('[data-citation-direction-tab="citations"]').click()
  await clickMark(page, 1200)
  await frame.locator('[data-citation-direction-tab="references"]').click()

  // Click the expanded hit rectangle rather than the small mark, using real screen coordinates.
  const target = await bounds(node(page, 1100).locator('[data-node-mark]'))
  await page.mouse.click(target.x + target.width / 2 + 10, target.y + target.height / 2)
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  await expect(selected).toBeFocused()

  const camera = await svg.getAttribute('viewBox')
  const panX = await svg.getAttribute('data-pan-x')
  const panY = await svg.getAttribute('data-pan-y')
  const queries = await requestCount(page)
  await frame.getByRole('button', { name: 'Set as center', exact: true }).click()
  const childTitle = page.locator('[data-citation-center-title]')
  await expect(childTitle).toHaveText(paperTitle(1100))
  await expect(childTitle).toBeFocused()
  await expect(currentFrame(page).getByText('Searching…', { exact: true })).toHaveCount(0)
  await expect.poll(() => requestCount(page)).toBe(queries + 2)
  await page.getByRole('button', { name: 'Back', exact: true }).filter({ hasText: 'Back' }).click()
  await expect(page.locator('[data-citation-center-title]')).toHaveText(rootTitle)
  await expect(page.locator('[data-citation-center-title]')).toBeFocused()
  await expect(svg).toHaveAttribute('viewBox', camera!)
  await expect(svg).toHaveAttribute('data-zoom', '1.2')
  await expect(svg).toHaveAttribute('data-pan-x', panX!)
  await expect(svg).toHaveAttribute('data-pan-y', panY!)
  await expect(selected).toHaveAttribute('aria-pressed', 'true')
  expect(await requestCount(page)).toBe(queries + 2)

  await frame.getByRole('button', { name: 'Set as center', exact: true }).click()
  await expect(childTitle).toBeFocused()
  await page.getByRole('button', { name: 'Original paper', exact: true }).click()
  await expect(page.locator('[data-citation-center-title]')).toBeFocused()
  expect(await requestCount(page)).toBe(queries + 2)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { literatureRecovery: { commands: unknown[] } }).literatureRecovery
          .commands.length
    )
  ).toBe(0)
}

export async function verifyCitationInspectorLifecycle(page: Page): Promise<void> {
  const frame = currentFrame(page)
  const details = frame.locator('[data-citation-inspector-toggle]')
  const svg = frame.locator('svg[data-zoom]')
  await clickMark(page, 1100)
  await frame.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(svg).toHaveAttribute('data-zoom', '1.2')
  const camera = await svg.evaluate((element) =>
    ['viewBox', 'data-zoom', 'data-pan-x', 'data-pan-y'].map((key) => element.getAttribute(key))
  )
  const queries = await requestCount(page)

  // Closing the selected-paper disclosure must keep the graph selection and camera alive.
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(node(page, 1100)).toHaveAttribute('aria-pressed', 'true')
  await expect(details).toHaveAttribute('title', 'Expand sidebar panel')

  // Reopening the disclosure is an in-place return to the same paper, without a lookup.
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(frame.getByRole('heading', { name: paperTitle(1100), exact: true })).toBeVisible()
  expect(
    await svg.evaluate((element) =>
      ['viewBox', 'data-zoom', 'data-pan-x', 'data-pan-y'].map((key) => element.getAttribute(key))
    )
  ).toEqual(camera)
  expect(await requestCount(page)).toBe(queries)
}

export async function verifyCitationNarrowLayout(
  page: Page,
  onState?: (state: 'collapsed' | 'selected' | 'paper-list') => Promise<void>
): Promise<void> {
  const frame = currentFrame(page)
  const details = frame.locator('[data-citation-inspector-toggle]')
  await verifyCitationDirectionTabs(page)
  await expectNoHorizontalOverflow(page)
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  const collapsedCanvas = await bounds(frame.locator('[data-citation-canvas]'))
  await onState?.('collapsed')
  await clickMark(page, 1100)
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expectReadableSelectedLabel(page)
  await expect(frame.locator('[data-citation-inspector-title]')).toBeVisible()
  await expect(frame.locator('[data-citation-inspector-actions]')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await onState?.('selected')
  const list = frame.locator('[data-citation-paper-list-toggle]')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  await frame.locator('[data-citation-inspector-pane] ol button').first().scrollIntoViewIfNeeded()
  await expectNoHorizontalOverflow(page)
  await onState?.('paper-list')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  const dialog = page.getByRole('dialog')
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const panel = await bounds(dialog)
  expect(panel.x).toBeGreaterThanOrEqual(0)
  expect(panel.y).toBeGreaterThanOrEqual(0)
  expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  const canvas = await bounds(frame.locator('[data-citation-canvas]'))
  const inspector = await bounds(frame.locator('[data-citation-inspector-pane]'))
  expect(inspector.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1)
  expect(canvas.height).toBeGreaterThanOrEqual(100)
  expect(collapsedCanvas.height).toBeGreaterThan(canvas.height + 40)
  for (const name of ['Set as center', 'Add to Inbox']) {
    const action = frame.getByRole('button', { name, exact: true })
    const box = await bounds(action)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    // Visible does not imply clickable: inspect the painted hit target as well.
    expect(
      await action.evaluate((element) => {
        const r = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      })
    ).toBe(true)
  }
  const actions = await bounds(frame.locator('[data-citation-inspector-actions]'))
  const svg = frame.locator('svg[data-zoom]')
  const camera = await svg.evaluate((element) =>
    ['data-zoom', 'data-pan-x', 'data-pan-y'].map((key) => element.getAttribute(key))
  )
  const queries = await requestCount(page)
  await frame.locator('[data-citation-inspector]').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await bounds(frame.locator('[data-citation-inspector-actions]'))).toEqual(actions)
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  const collapsedAgain = await bounds(frame.locator('[data-citation-canvas]'))
  expect(collapsedAgain.height).toBeGreaterThan(canvas.height + 40)
  await expect(node(page, 1100)).toHaveAttribute('aria-pressed', 'true')
  await details.click()
  await expect(details).toHaveAttribute('aria-expanded', 'true')
  await expect(frame.getByRole('heading', { name: paperTitle(1100), exact: true })).toBeVisible()
  expect(
    await svg.evaluate((element) =>
      ['data-zoom', 'data-pan-x', 'data-pan-y'].map((key) => element.getAttribute(key))
    )
  ).toEqual(camera)
  expect(await requestCount(page)).toBe(queries)
  await frame.getByRole('button', { name: 'Add to Inbox', exact: true }).click()
  await expect(frame.getByText('In Inbox', { exact: true })).toBeVisible()
}

export async function verifyCitationFocusAndClose(page: Page): Promise<void> {
  // Real pointer selection followed by keyboard navigation exercises Chromium's SVG focus.
  const mark = await bounds(node(page, 1100).locator('[data-node-mark]'))
  await page.mouse.click(mark.x + mark.width / 2 + 10, mark.y + mark.height / 2)
  await expect(node(page, 1100)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(node(page, 1101)).toBeFocused()
  await expect(node(page, 1101)).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Home')
  await expect(node(page, 1000)).toBeFocused()
  await page.keyboard.press('Tab')
  const inspect = currentFrame(page).getByRole('button', { name: 'View selected paper' })
  await expect(inspect).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(currentFrame(page).locator('[data-citation-inspector-title]')).toBeFocused()
  const list = currentFrame(page).locator('[data-citation-paper-list-toggle]')
  await list.click()
  await expect(list).toHaveAttribute('aria-expanded', 'true')
  await currentFrame(page)
    .locator('[data-citation-inspector]')
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
  await page.keyboard.press('Escape')
  await expect(list).toHaveAttribute('aria-expanded', 'false')
  await expect(list).toBeFocused()
  await expect(currentFrame(page).locator('[data-citation-inspector-title]')).toBeVisible()
  await expect(currentFrame(page).locator('[data-citation-inspector]')).toHaveJSProperty(
    'scrollTop',
    0
  )
  await page.keyboard.press('Escape')
  const details = currentFrame(page).locator('[data-citation-inspector-toggle]')
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await expect(details).toBeFocused()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const initiator = page.getByRole('button', { name: rootTitle, exact: true })
  await expect(initiator).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
}
