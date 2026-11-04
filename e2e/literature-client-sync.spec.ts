import {
  literatureCandidateInputSchema,
  literatureItemInputSchema
} from '@aipoch/literature-library/contracts'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { openAllReferences } from './fixtures/library'

const configureLiveProxy = async (page: Page): Promise<void> => {
  const server = process.env.OPEN_SCIENCE_LITERATURE_PROXY
  if (server)
    await page.evaluate(
      (server) =>
        window.api.settings.setNetworkProxy({
          mode: 'manual',
          server,
          bypassRules: 'localhost,127.0.0.1'
        }),
      server
    )
}

// Live providers are a separate acceptance check; portable regressions use fixed responses.
test.describe('live literature providers', () => {
  test.use({ windowMode: 'normal' })
  test.skip(
    process.env.OPEN_SCIENCE_LITERATURE_LIVE !== '1',
    'Requires live Crossref and arXiv access'
  )
  test('reuses one linked reference when two Electron windows save concurrently', async ({
    app
  }, testInfo) => {
    const first = await app.completeOnboarding()
    await configureLiveProxy(first)
    await first.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    const second = await app.openAdditionalRenderer()
    const pages = [first, second]
    const readIds = (page: typeof first): Promise<string[]> =>
      page.evaluate(async () => {
        const result = await window.api.literature.search({ scope: 'library', allItemIds: true })
        return result.itemIds ?? []
      })
    const before = await readIds(first)
    await Promise.all(pages.map((page) => openAllReferences(page)))
    const reviews = await Promise.all(
      pages.map(async (page): Promise<Locator> => {
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await page
          .getByRole('menuitem', { name: 'Add from identifiers or links', exact: true })
          .click()
        await page
          .getByLabel('DOI, arXiv, PMID, PMCID or links', { exact: true })
          .fill('https://doi.org/10.1038/nature12373')
        await page.getByRole('button', { name: 'Find reference', exact: true }).click()
        const review = page.getByRole('dialog', { name: 'Review reference details' })
        await expect(review).toBeVisible({ timeout: 60_000 })
        await expect(review.getByRole('heading', { name: /thermometry/i })).toBeVisible()
        await review.getByRole('button', { name: 'Edit details', exact: true }).click()
        const editor = page.getByRole('dialog', { name: 'Edit reference details' })
        await expect(editor).toBeVisible()
        await editor.getByLabel('Title', { exact: true }).fill('Concurrent linked reference')
        await editor.getByRole('button', { name: 'Back to review', exact: true }).click()
        await expect(review).toBeVisible()
        return review
      })
    )
    expect(await readIds(first)).toEqual(before)
    await Promise.all(
      reviews.map((review) => review.getByRole('button', { name: 'Save', exact: true }).click())
    )
    await Promise.all(reviews.map((review) => expect(review).toBeHidden()))
    const after = await readIds(first)
    expect(after).toHaveLength(before.length + 1)
    expect((await readIds(second)).sort()).toEqual([...after].sort())
    const id = after.find((candidate) => !before.includes(candidate))!
    for (const [index, page] of pages.entries()) {
      await expect(
        page.getByRole('heading', { name: 'Concurrent linked reference', exact: true })
      ).toBeVisible()
      const item = await page.evaluate((id) => window.api.literature.get(id), id)
      expect(item?.item.identifiers).toContainEqual(
        expect.objectContaining({ scheme: 'doi', value: '10.1038/nature12373' })
      )
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText('Concurrent linked reference', { exact: true })).toHaveCount(1)
      await page.screenshot({
        path: testInfo.outputPath(`concurrent-link-window-${index + 1}.png`)
      })
    }
  })

  test('imports live DOI and arXiv links through Electron and preserves reviewed metadata after restart', async ({
    app
  }, testInfo) => {
    test.setTimeout(240_000)
    let page = await app.completeOnboarding()
    await configureLiveProxy(page)
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    await openAllReferences(page)
    const readIds = (): Promise<string[]> =>
      page.evaluate(async () => {
        const result = await window.api.literature.search({ scope: 'library', allItemIds: true })
        return result.itemIds ?? []
      })
    const baseline = await readIds()
    const saved: Array<{
      id: string
      title: string
      scheme: 'doi' | 'arxiv'
      value: string
    }> = []
    for (const [url, expectedTitle, source, scheme, value] of [
      ['https://doi.org/10.1038/nature12373', /thermometry/i, 'DOI', 'doi', '10.1038/nature12373'],
      [
        'https://arxiv.org/pdf/1706.03762v1.pdf',
        /Attention Is All You Need/i,
        'arXiv',
        'arxiv',
        '1706.03762'
      ]
    ] as const) {
      const add = page.getByRole('button', { name: 'Add', exact: true })
      const lookup = async (): Promise<Locator> => {
        await add.click()
        await page
          .getByRole('menuitem', { name: 'Add from identifiers or links', exact: true })
          .click()
        const input = page.getByLabel('DOI, arXiv, PMID, PMCID or links', { exact: true })
        await expect(input).toBeFocused()
        await input.fill(url)
        await input.press('ControlOrMeta+Enter')
        const review = page.getByRole('dialog', { name: 'Review reference details' })
        await expect(review).toBeVisible({ timeout: 60_000 })
        await expect(review).toContainText(`Retrieved via ${source}.`)
        await expect(review.getByRole('heading', { name: expectedTitle })).toBeVisible()
        return review
      }
      const before = await readIds()
      const cancelled = await lookup()
      expect(await readIds()).toEqual(before)
      await cancelled.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(cancelled).toBeHidden()
      await expect(add).toBeFocused()
      expect(await readIds()).toEqual(before)

      const review = await lookup()
      const title = `Reviewed live ${source} reference`
      await review.getByRole('button', { name: 'Edit details', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Edit reference details' })
      await expect(editor).toBeVisible()
      await editor.getByLabel('Title', { exact: true }).fill(title)
      await editor.getByRole('button', { name: 'Back to review', exact: true }).click()
      await expect(review).toBeVisible()
      await review.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(review).toBeHidden()
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
      const after = await readIds()
      expect(after).toHaveLength(before.length + 1)
      const id = after.find((candidate) => !before.includes(candidate))!
      saved.push({ id, title, scheme, value })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // Reimporting the same identifier must preserve the user's reviewed title and item identity.
      const duplicate = await lookup()
      await duplicate.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(duplicate).toBeHidden()
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
      expect((await readIds()).sort()).toEqual(after.sort())
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    page = await app.restartAfterCrash({ force: true })
    expect(await readIds()).toHaveLength(baseline.length + saved.length)
    for (const { id, title, scheme, value } of saved) {
      const restored = await page.evaluate((id) => window.api.literature.get(id), id)
      expect(restored?.item.title).toBe(title)
      expect(restored?.item.identifiers).toContainEqual(expect.objectContaining({ scheme, value }))
    }
    await testInfo.attach('live-link-persistence.json', {
      contentType: 'application/json',
      body: JSON.stringify({ saved, restoredAfterForcedRestart: true })
    })
  })

  test('imports live PubMed records and a mixed batch with selection and restart persistence', async ({
    app
  }, testInfo) => {
    test.setTimeout(300_000)
    let page = await app.completeOnboarding()
    await configureLiveProxy(page)
    await openAllReferences(page)
    const readIds = (): Promise<string[]> =>
      page.evaluate(
        async () =>
          (await window.api.literature.search({ scope: 'library', allItemIds: true })).itemIds ?? []
      )
    const baseline = await readIds()
    const reviewed: { id: string; title: string }[] = []
    const openLookup = async (input: string): Promise<void> => {
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page
        .getByRole('menuitem', { name: 'Add from identifiers or links', exact: true })
        .click()
      const field = page.getByLabel('DOI, arXiv, PMID, PMCID or links', { exact: true })
      await field.fill(input)
      await expect(field).toHaveValue(input)
      await page.getByRole('button', { name: 'Find reference', exact: true }).click()
    }
    for (const [input, source, expectedTitle] of [
      ['pmid:35486828', 'PMID', /Discrimination of three Angelica/i],
      ['PMC5753258', 'PMCID', /Europe PMC in 2017/i]
    ] as const) {
      const before = await readIds()
      await openLookup(input)
      const review = page.getByRole('dialog', { name: 'Review reference details' })
      await expect(review).toBeVisible({ timeout: 60_000 })
      await expect(review).toContainText(`Retrieved via ${source}.`)
      await expect(review).toContainText(input.replace(/^pmid:/u, ''))
      await expect(review.getByRole('heading', { name: expectedTitle })).toBeVisible()
      expect(await readIds()).toEqual(before)
      await page.screenshot({ path: testInfo.outputPath(`live-single-${source}.png`) })
      await review.getByRole('button', { name: 'Edit details', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Edit reference details' })
      const title = `Reviewed live ${source} reference`
      await editor.getByLabel('Title', { exact: true }).fill(title)
      await editor.getByRole('button', { name: 'Back to review', exact: true }).click()
      await review.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(review).toBeHidden()
      const after = await readIds()
      expect(after).toHaveLength(before.length + 1)
      reviewed.push({ id: after.find((id) => !before.includes(id))!, title })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    const inputs = [
      '10.1038/nphys1170',
      'pmid:35486828',
      'PMC5753258',
      'arxiv:1810.04805',
      'unsupported example',
      'https://doi.org/10.1038/nphys1170'
    ].join('\n')
    const beforeBatch = await readIds()
    const previewBatch = async (): Promise<Locator> => {
      await openLookup(inputs)
      const reviewResults = page.getByRole('button', { name: 'Review references', exact: true })
      await expect(reviewResults).toBeVisible({ timeout: 120_000 })
      await expect(page.getByText('unsupported example', { exact: true })).toBeVisible()
      await expect(
        page.getByText(/BERT: Pre-training of Deep Bidirectional Transformers/)
      ).toBeVisible()
      expect((await readIds()).sort()).toEqual([...beforeBatch].sort())
      await page.screenshot({ path: testInfo.outputPath('live-batch-lookup.png') })
      await reviewResults.click()
      const preview = page.getByRole('dialog', { name: 'Import references', exact: true })
      await expect(preview.getByRole('checkbox')).toHaveCount(4)
      const exclude = preview.getByRole('checkbox', { name: /Measured measurement/ })
      await exclude.uncheck()
      await expect(preview.getByText('3 of 4 selected', { exact: true })).toBeVisible()
      await expect(
        preview.getByRole('button', { name: 'Import references', exact: true })
      ).toBeEnabled()
      expect((await readIds()).sort()).toEqual([...beforeBatch].sort())
      return preview
    }
    const cancelled = await previewBatch()
    await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(cancelled).toBeHidden()
    expect((await readIds()).sort()).toEqual([...beforeBatch].sort())
    const preview = await previewBatch()
    await page.screenshot({ path: testInfo.outputPath('live-batch-selection.png') })
    await preview.getByRole('button', { name: 'Import references', exact: true }).click()
    await expect(preview.getByRole('button', { name: 'Done', exact: true })).toBeVisible({
      timeout: 30_000
    })
    await page.screenshot({ path: testInfo.outputPath('live-batch-receipt.png') })
    await preview.getByRole('button', { name: 'Done', exact: true }).click()
    const after = await readIds()
    expect(after).toHaveLength(baseline.length + 3)
    const added = after.filter((id) => !beforeBatch.includes(id))
    expect(added).toHaveLength(1)
    const snapshot = await page.evaluate(
      async (ids) => Promise.all(ids.map((id) => window.api.literature.get(id))),
      after.filter((id) => !baseline.includes(id))
    )
    for (const { id, title } of reviewed)
      expect(snapshot.find((item) => item?.id === id)?.item.title).toBe(title)
    const bert = snapshot.find((item) => item?.id === added[0])!
    expect(bert.item.identifiers).toContainEqual(
      expect.objectContaining({ scheme: 'arxiv', value: '1810.04805' })
    )
    expect(bert.item.title).toMatch(/BERT: Pre-training/)
    page = await app.restartAfterCrash({ force: true })
    expect((await readIds()).sort()).toEqual([...after].sort())
    for (const item of snapshot) {
      expect(item).toBeDefined()
      const restored = await page.evaluate((id) => window.api.literature.get(id), item!.id)
      expect(restored?.item).toEqual(item!.item)
    }
    await openAllReferences(page)
    for (const { title } of reviewed)
      await expect(page.getByText(title, { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('live-after-restart.png') })
    await testInfo.attach('live-batch-persistence.json', {
      contentType: 'application/json',
      body: JSON.stringify({
        baseline,
        after,
        reviewed,
        snapshot,
        restoredAfterForcedRestart: true
      })
    })
  })
})

test('synchronizes ordinary writes across two Electron renderers and a Web client', async ({
  app,
  browser
}) => {
  test.setTimeout(180_000)
  const first = await app.completeOnboarding()
  await first.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const second = await app.openAdditionalRenderer()
  const web = await browser.newPage()
  try {
    await web.goto(await app.authenticatedWebUrl())
    for (const page of [first, second, web]) await openAllReferences(page)
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Created in desktop'
    })
    const created = await first.evaluate(
      (item) => window.api.literature.transact({ kind: 'create-item', item }),
      item
    )
    for (const page of [second, web])
      await expect(page.getByText(item.title, { exact: true })).toBeVisible()
    const saved = await web.evaluate(async (id) => {
      const current = (await window.api.literature.get(id))!
      await window.api.literature.transact({
        kind: 'update-item',
        itemId: id,
        expectedMetadataRevision: current.metadataRevision,
        item: { ...current.item, title: 'Edited in Web' }
      })
      return id
    }, created.id)
    for (const page of [first, second])
      await expect(page.getByText('Edited in Web', { exact: true })).toBeVisible()
    const collection = await second.evaluate(() =>
      window.api.literature.transact({ kind: 'create-collection', name: 'Shared collection' })
    )
    for (const page of [first, web])
      await expect(
        page.getByRole('button', { name: 'Shared collection', exact: true })
      ).toBeVisible()
    await web.evaluate(
      ({ collectionId, itemId }) =>
        window.api.literature.transact({
          kind: 'set-collection-item',
          collectionId,
          itemId,
          included: true
        }),
      { collectionId: collection.id, itemId: saved }
    )
    await first.getByRole('button', { name: 'Shared collection', exact: true }).click()
    await expect(first.getByText('Edited in Web', { exact: true })).toBeVisible()
    const candidate = literatureCandidateInputSchema.parse({
      item: { itemType: 'journalArticle', title: 'Accepted from Inbox' },
      source: { provider: 'manual', rawMetadata: {} },
      origin: { kind: 'user' }
    })
    const staged = await first.evaluate(
      (candidate) => window.api.literature.transact({ kind: 'stage-candidate', candidate }),
      candidate
    )
    await second.evaluate(
      (candidateId) => window.api.literature.transact({ kind: 'accept-candidate', candidateId }),
      staged.id
    )
    await expect(web.getByText('Accepted from Inbox', { exact: true })).toBeVisible()
    await second.evaluate(
      (id) =>
        window.api.literature.transact({
          kind: 'set-item-lifecycle',
          itemIds: [id],
          state: 'deleted'
        }),
      created.id
    )
    await expect(first.getByText('Edited in Web', { exact: true })).toHaveCount(0)
    await expect(web.getByText('Edited in Web', { exact: true })).toHaveCount(0)
    // Suspend the real Web transport, commit while disconnected, then let replay/recovery restore it.
    await web.context().setOffline(true)
    const missed = await first.evaluate(
      (item) =>
        window.api.literature.transact({
          kind: 'create-item',
          item: { ...item, title: 'Committed while Web was offline' }
        }),
      item
    )
    expect(missed.id).toBeTruthy()
    await web.context().setOffline(false)
    await expect(web.getByText('Committed while Web was offline', { exact: true })).toBeVisible()
  } finally {
    await web.close()
  }
})

test('protects unsaved reference edits and keeps save actions visible', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await openAllReferences(page)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add reference', exact: true }).click()
  const title = page.getByLabel('Title', { exact: true })
  await title.fill('Unsaved reference')
  await title.press('Escape')
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('Discard unsaved changes?')
  await confirmation.getByRole('button', { name: 'Keep editing' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(title).toBeFocused()
  await expect(title).toHaveValue('Unsaved reference')
  await title.press('Escape')
  await confirmation.getByRole('button', { name: 'Discard changes' }).click()
  await expect(title).toHaveCount(0)
  const item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Saved reference'
  })
  const created = await page.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    item
  )
  await page.getByText(item.title, { exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit metadata', exact: true }).click()
  await title.fill('Draft reference')
  await page.setViewportSize({ width: 1000, height: 650 })
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const box = await save.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(650)
  await detail.getByRole('button', { name: 'Back', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Keep editing' }).click()
  await expect(title).toHaveValue('Draft reference')
  await save.click()
  await expect(title).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(async (id) => (await window.api.literature.get(id))?.item.title, created.id)
    )
    .toBe('Draft reference')
})

test('finishes manual reference creation before opening its saved detail', async ({ app }) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  await openAllReferences(page)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add reference', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Add reference', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill('Manual creation regression')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Manual creation regression' })).toBeVisible()
})

test('formats citations from packaged styles and preserves style errors through desktop and Web', async ({
  app,
  browser
}) => {
  const page = await app.completeOnboarding()
  const web = await browser.newPage()
  try {
    await web.goto(await app.authenticatedWebUrl())
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Packaged citation acceptance',
      issuedYear: 2025,
      creators: [
        { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' }
      ]
    })
    const created = await page.evaluate(
      (item) => window.api.literature.transact({ kind: 'create-item', item }),
      item
    )
    for (const client of [page, web]) {
      const styles = await client.evaluate(() =>
        window.api.literature.citationStyles({ kind: 'list' })
      )
      expect(styles.styles.some((style) => style.id === 'apa')).toBe(true)
      const formatted = await client.evaluate(
        (id) =>
          window.api.literature.formatReferences({
            itemIds: [id],
            styleId: 'apa',
            locale: 'en-US'
          }),
        created.id
      )
      expect(formatted.references[0].reference).toContain(item.title)
      expect(formatted.exports.bibtex).toContain(item.title)
      const failure = await client.evaluate(async () => {
        try {
          await window.api.literature.citationStyles({ kind: 'import', content: '<not-a-style/>' })
          return null
        } catch (error) {
          return (error as { code?: string }).code
        }
      })
      expect(failure).toBe('csl-unsupported-style')
    }
  } finally {
    await web.close()
  }
})
