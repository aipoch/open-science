import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { expect, type Page, type Locator } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { test } from './fixtures/electron-app'
import { openAllReferences } from './fixtures/library'

// Opt-in only: exercises the full application and public services, without intercepting requests.
test.describe('live citation graph providers', () => {
  test.use({ windowMode: 'normal' })
  test.skip(process.env.OPEN_SCIENCE_CITATION_LIVE !== '1', 'Requires public citation APIs')
  const doi = process.env.OPEN_SCIENCE_CITATION_DOI ?? '10.1093/nar/gkz289'
  const seedTitle = `Live citation seed (${doi})`
  const frame = (page: Page): Locator => page.locator('[data-current-frame="true"]')
  const ids = (page: Page): Promise<string[]> =>
    frame(page)
      .locator('[data-paper-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-paper-id')!))
  const settled = async (page: Page): Promise<void> => {
    await expect(frame(page)).toBeVisible()
    await expect(frame(page).locator('[data-citation-direction-tab="all"]')).toBeEnabled({
      timeout: 90_000
    })
    await expect(frame(page).getByRole('alert')).toHaveCount(0)
    await expect(frame(page).locator('[data-paper-id]')).not.toHaveCount(0)
  }
  const centerFocused = async (page: Page): Promise<void> => {
    const title = page.locator('[data-citation-center-title]')
    // Do not focus the element from the test: the application must own DOM focus.
    // A normal Electron window can lose OS focus while a live request is pending.
    await expect
      .poll(() => title.evaluate((element) => element.ownerDocument.activeElement === element))
      .toBe(true)
    await page.bringToFront()
    await expect(title).toBeFocused()
  }

  for (const source of [
    { choice: 'Europe PMC', provider: 'europe-pmc', prefix: 'europe-pmc:' },
    { choice: 'OpenCitations · SKG-IF', provider: 'opencitations', prefix: 'opencitations:' },
    {
      choice: 'OpenCitations · Index v2',
      provider: 'opencitations',
      prefix: 'opencitations:'
    }
  ]) {
    test(`${source.choice}: real queries, pagination, temporary center and cached return`, async ({
      app
    }, info) => {
      test.setTimeout(300_000)
      const page = await app.completeOnboarding()
      await app.setMainWindowSize(1440, 1000)
      const proxy = process.env.OPEN_SCIENCE_LITERATURE_PROXY
      if (proxy)
        await page.evaluate(
          (server) =>
            window.api.settings.setNetworkProxy({
              mode: 'manual',
              server,
              bypassRules: 'localhost,127.0.0.1'
            }),
          proxy
        )
      const receipt = await page.evaluate(
        (item) => window.api.literature.transact({ kind: 'create-item', item }),
        literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: seedTitle,
          identifiers: [{ scheme: 'doi', value: doi }]
        })
      )
      const evidence: Record<string, unknown> = { source: source.choice, doi, receipt }
      await page.evaluate(() => {
        const events: object[] = []
        Object.assign(window, { citationFocusEvents: events })
        for (const kind of ['focusin', 'focusout', 'blur', 'focus'])
          window.addEventListener(
            kind,
            (event) => {
              const element = event.target instanceof Element ? event.target : undefined
              events.push({
                kind,
                time: performance.now(),
                tag: element?.tagName,
                title: element?.hasAttribute('data-citation-center-title'),
                label: element?.getAttribute('aria-label'),
                text: element?.textContent?.slice(0, 140)
              })
            },
            true
          )
      })
      try {
        await openAllReferences(page)
        await page.getByRole('button', { name: seedTitle, exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'References', exact: true }).click()
        await dialog.getByRole('combobox', { name: 'Citation source' }).click()
        await page.getByRole('option', { name: source.choice, exact: true }).click()
        await dialog.getByRole('button', { name: 'Citation graph', exact: true }).click()
        await settled(page)
        await expect(dialog.getByRole('combobox', { name: 'Citation source' })).toHaveText(
          source.choice
        )
        await page.screenshot({ path: info.outputPath('live-citation-graph-initial.png') })
        const rootIds = await ids(page)
        evidence.rootIds = rootIds
        expect(rootIds.every((id) => id.startsWith(source.prefix))).toBe(true)
        await expect(frame(page).locator('[data-citation-direction-tab="all"]')).toHaveAttribute(
          'aria-selected',
          'true'
        )
        await expect
          .poll(() => frame(page).locator('[data-direction="references"]').count())
          .toBeGreaterThan(0)
        const edges = await frame(page)
          .locator('[data-source][data-target]')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              source: element.getAttribute('data-source'),
              target: element.getAttribute('data-target'),
              direction: element.getAttribute('data-direction')
            }))
          )
        evidence.rootEdges = edges
        expect(
          edges.every((edge) =>
            edge.direction === 'references'
              ? edge.source === rootIds[0]
              : edge.target === rootIds[0]
          )
        ).toBe(true)

        const pagination: Record<string, unknown>[] = []
        for (const direction of ['References', 'Papers citing this paper']) {
          await frame(page)
            .locator('[data-citation-direction-tabs]')
            .getByRole('tab', {
              name: direction === 'References' ? 'References' : 'Cited by',
              exact: true
            })
            .click()
          await settled(page)
          const more = frame(page)
            .getByRole('region', { name: direction, exact: true })
            .getByRole('button', { name: 'Load more', exact: true })
          if (!(await more.isVisible())) {
            pagination.push({ direction, hasNextPage: false })
            continue
          }
          const before = await ids(page)
          await more.click()
          await settled(page)
          const after = await ids(page)
          const added = after.filter((id) => !before.includes(id))
          expect(added.length).toBeGreaterThan(0)
          expect(new Set(after).size).toBe(after.length)
          expect(before.every((id) => after.includes(id))).toBe(true)
          pagination.push({ direction, hasNextPage: true, added })
        }
        evidence.pagination = pagination
        expect(pagination.some((entry) => entry.hasNextPage)).toBe(true)
        const snapshot = await ids(page)
        const svg = frame(page).locator('svg[data-zoom]')
        const camera = await svg.getAttribute('viewBox')
        // Prefer a citing paper: old foundational references can legitimately exceed
        // the complete Index snapshot bound when explored as a new center.
        const neighborId = await frame(page)
          .locator('[data-paper-id][data-relation="citations"]')
          .first()
          .getAttribute('data-paper-id')
        const paperList = frame(page).locator('[data-citation-paper-list-toggle]')
        if ((await paperList.getAttribute('aria-expanded')) === 'false') await paperList.click()
        const neighborRow = frame(page).locator(`[data-citation-paper-id="${neighborId}"]`)
        await neighborRow.click()
        await expect(neighborRow).toHaveAttribute('aria-pressed', 'true')
        await frame(page).getByRole('button', { name: 'View details' }).click()
        await expect(paperList).toHaveAttribute('aria-expanded', 'false')
        const selected = frame(page).locator('[data-paper-id][aria-pressed="true"]')
        const childId = await selected.getAttribute('data-paper-id')
        expect(childId).toBe(neighborId)
        evidence.childId = childId
        const title = (await selected.locator('title').textContent())!.split('\n')[0]
        await expect(
          frame(page)
            .locator('[data-citation-inspector-pane]')
            .getByRole('heading', { name: title, exact: true })
        ).toBeVisible()
        await page.screenshot({ path: info.outputPath('live-citation-graph-selected.png') })
        await frame(page).getByRole('button', { name: 'Set as center', exact: true }).click()
        await settled(page)
        await expect(page.locator('[data-citation-center-title]')).toHaveText(title)
        await expect(frame(page).locator('[data-paper-id]').first()).toHaveAttribute(
          'data-paper-id',
          childId!
        )
        await centerFocused(page)
        evidence.childIds = await ids(page)
        await page
          .getByRole('button', { name: 'Back', exact: true })
          .filter({ hasText: 'Back' })
          .click()
        await expect(page.locator('[data-citation-center-title]')).toHaveText(seedTitle)
        await centerFocused(page)
        expect(await ids(page)).toEqual(snapshot)
        await expect(svg).toHaveAttribute('viewBox', camera!)
        await expect(frame(page).locator('[data-paper-id][aria-pressed="true"]')).toHaveAttribute(
          'data-paper-id',
          childId!
        )
        const catalog = await page.evaluate(() =>
          window.api.literature.search({ scope: 'library', allItemIds: true })
        )
        expect(catalog.itemIds).toEqual([receipt.id])
        evidence.outcome = 'passed'
      } finally {
        evidence.focus = await page.evaluate(() => ({
          documentFocused: document.hasFocus(),
          activeTag: document.activeElement?.tagName,
          activeText: document.activeElement?.textContent?.slice(0, 140),
          events: (window as unknown as { citationFocusEvents: object[] }).citationFocusEvents
        }))
        evidence.alerts = await page.getByRole('alert').allTextContents()
        evidence.visibleText = await page
          .getByRole('dialog')
          .innerText()
          .catch(() => '')
        const evidencePath = info.outputPath('live-citation-evidence.json')
        await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
        await info.attach('live-citation-evidence', {
          path: evidencePath,
          contentType: 'application/json'
        })
        await page.screenshot({ path: info.outputPath('live-citation-graph.png') })
        const log = await app.captureMainLog('live-citation-main.log')
        await info.attach('live-citation-main-log', { path: log, contentType: 'text/plain' })
      }
    })
  }
})
