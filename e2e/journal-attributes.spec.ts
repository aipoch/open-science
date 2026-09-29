import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from './fixtures/electron-app'
import type { JournalResult } from '../src/shared/journal-attributes'
import { literatureItemInputSchema } from '../src/shared/literature'

// Independently authored fixtures; never use user spreadsheets or provider datasets.
const prepare = (
  page: Page,
  count: number,
  source: string
): Promise<{ token: string; digest: string }> =>
  page.evaluate(
    async ({ count, source }) => {
      const { token } = await window.api.literature.journals({
        action: 'begin',
        policy: 'fill',
        definition: {
          source,
          year: 2035,
          fields: [
            { id: 'band', label: 'Editorial band', kind: 'singleSelect', colors: {}, visible: true }
          ]
        }
      })
      for (let offset = 0; offset < count; offset += 100)
        await window.api.literature.journals({
          action: 'append',
          token: token!,
          offset,
          rows: Array.from({ length: Math.min(100, count - offset) }, (_, index) => ({
            row: offset + index + 2,
            name: `Imaginary IPC Review ${offset + index}`,
            aliases: [],
            issns: offset + index === 0 ? ['1234-5679', '2049-3630'] : [],
            values: { band: `Band ${(offset + index) % 135}` }
          }))
        })
      const preview = await window.api.literature.journals({
        action: 'preview',
        token: token!,
        offset: 0
      })
      if (preview.ready !== count) throw new Error('Synthetic journal rows did not validate')
      return { token: token!, digest: preview.digest! }
    },
    { count, source }
  )

const openJournals = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'Journals', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Journals', exact: true })).toBeVisible()
}

test('resolves journals through real IPC in two windows and persists colors outside the first page', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  const first = await app.completeOnboarding()
  await first.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const draft = await prepare(first, 20_000, 'Invented IPC source')
  const saved = await first.evaluate(
    (draft) => window.api.literature.journals({ action: 'commit', ...draft, skipProblems: false }),
    draft
  )
  const dataset = saved.datasets![0]
  const paper = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Imaginary IPC reference',
    containerTitle: 'A different displayed title',
    typeFields: { eissn: '2049-3630' }
  })
  await first.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    paper
  )
  // Restart drops the main-process cache; two renderer requests then exercise one cold owner.
  const primary = await app.restart()
  const second = await app.openAdditionalRenderer()
  const resolve = (page: Page): Promise<{ milliseconds: number; result: JournalResult }> =>
    page.evaluate(async () => {
      const started = performance.now()
      const result = await window.api.literature.journals({
        action: 'resolve',
        identities: Array.from({ length: 200 }, (_, i) => ({
          name: `Imaginary IPC Review ${i}`,
          aliases: [],
          issns: []
        }))
      })
      return { milliseconds: performance.now() - started, result }
    })
  const results = await Promise.all([resolve(primary), resolve(second)])
  for (const { result } of results)
    expect(result.matches?.every((match) => match.status === 'matched')).toBe(true)
  await testInfo.attach('journal-ipc-timings', {
    body: JSON.stringify(results.map(({ milliseconds }) => milliseconds)),
    contentType: 'application/json'
  })
  await openJournals(primary)
  await primary.getByRole('button', { name: 'Customize columns', exact: true }).click()
  await primary.getByRole('button', { name: 'Edit category colors', exact: true }).click()
  await primary.getByRole('textbox', { name: 'Search choices', exact: true }).fill('Band 134')
  await primary.getByRole('button', { name: 'Color for Band 134', exact: true }).click()
  await primary.getByRole('button', { name: 'Blue', exact: true }).click()
  await primary.keyboard.press('Escape')
  await expect(
    primary.getByRole('dialog', { name: 'Editorial band: Edit category colors', exact: true })
  ).toBeHidden()
  await primary.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    primary.getByRole('button', { name: 'Customize columns', exact: true })
  ).toBeVisible()
  await primary.getByRole('button', { name: 'Customize columns', exact: true }).click()
  await primary
    .getByRole('textbox', { name: 'Attribute name', exact: true })
    .fill('Local draft retained')
  await second.evaluate(async () => {
    const dataset = (await window.api.literature.journals({ action: 'list' })).datasets![0]
    await window.api.literature.journals({
      action: 'fields',
      datasetId: dataset.id,
      expectedRevision: dataset.revision,
      fields: dataset.fields.map((field) => ({ ...field, label: 'Remote editorial band' }))
    })
  })
  await expect(
    primary.getByText(
      'Journal data changed in another window. Your draft is preserved. Cancel this draft to load the latest data.',
      { exact: true }
    )
  ).toBeVisible()
  await expect(primary.getByRole('textbox', { name: 'Attribute name', exact: true })).toHaveValue(
    'Local draft retained'
  )
  await expect(primary.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await primary.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(
    primary.getByRole('button', { name: 'Remote editorial band', exact: true })
  ).toBeVisible()
  const restored = await app.restart()
  const stored = await restored.evaluate(() => window.api.literature.journals({ action: 'list' }))
  expect(
    stored.datasets?.find((value) => value.id === dataset.id)?.fields[0].colors['Band 134']
  ).toBe('blue')
  const resolved = await restored.evaluate(() =>
    window.api.literature.journals({
      action: 'resolve',
      identities: [{ name: 'A different displayed title', aliases: [], issns: ['2049-3630'] }]
    })
  )
  expect(resolved.matches?.[0].attributes[0]).toMatchObject({
    label: 'Remote editorial band',
    value: 'Band 0'
  })
})

for (const crash of [false, true]) {
  test(`keeps a journal import atomic when ${crash ? 'crashing' : 'quitting'} with its commit pending`, async ({
    app
  }) => {
    test.setTimeout(240_000)
    const page = await app.completeOnboarding()
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    const baseline = await prepare(page, 1, 'Invented preserved source')
    await page.evaluate(
      (draft) =>
        window.api.literature.journals({ action: 'commit', ...draft, skipProblems: false }),
      baseline
    )
    const draft = await prepare(page, 100_000, 'Invented interrupted source')
    const application = (app as unknown as { application: ElectronApplication }).application
    const configRoot = await application.evaluate(() => process.env.OPEN_SCIENCE_CONFIG_ROOT!)
    await page.evaluate((draft) => {
      const state = window as typeof window & { journalCommitPending?: boolean }
      state.journalCommitPending = true
      void window.api.literature.journals({ action: 'commit', ...draft, skipProblems: false }).then(
        () => {
          state.journalCommitPending = false
        },
        () => {
          state.journalCommitPending = false
        }
      )
    }, draft)
    // Wait for a real rollback journal with a flushed header: the transaction has
    // reached disk, so this tests recovery rather than killing only its preparation.
    await expect
      .poll(
        async () => {
          const file = await open(join(configRoot, 'open-science.db-journal'), 'r').catch(
            () => undefined
          )
          if (!file) return false
          try {
            const header = Buffer.alloc(8)
            await file.read(header, 0, 8, 0)
            return header.toString('hex') === 'd9d505f920a163d7'
          } finally {
            await file.close()
          }
        },
        { timeout: 30_000, intervals: [25] }
      )
      .toBe(true)
    expect(
      await page.evaluate(
        () => (window as typeof window & { journalCommitPending?: boolean }).journalCommitPending
      )
    ).toBe(true)
    const restored = crash ? await app.restartAfterCrash({ force: true }) : await app.restart()
    const result = await restored.evaluate(() => window.api.literature.journals({ action: 'list' }))
    expect(
      result.datasets?.find((dataset) => dataset.source === 'Invented preserved source')?.count
    ).toBe(1)
    const interrupted = result.datasets?.find(
      (dataset) => dataset.source === 'Invented interrupted source'
    )
    // Closing may finish the transaction or roll it back; partial data is never acceptable.
    expect(interrupted?.count ?? 0).toBe(interrupted ? 100_000 : 0)
    if (interrupted) {
      const tail = await restored.evaluate(
        (datasetId) =>
          window.api.literature.journals({
            action: 'entries',
            datasetId,
            offset: 99_950,
            query: '',
            descending: false
          }),
        interrupted.id
      )
      expect(tail.entries).toHaveLength(50)
    }
  })
}

test('checks historical references by name and refreshes alignment after a new reference', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const draft = await prepare(page, 1, 'Invented alignment source')
  await page.evaluate(
    (draft) => window.api.literature.journals({ action: 'commit', ...draft, skipProblems: false }),
    draft
  )
  const papers = [
    { title: 'Imaginary name-only reference', containerTitle: 'Imaginary IPC Review 0' },
    {
      title: 'Imaginary numbered reference',
      containerTitle: 'Different displayed name',
      typeFields: { issn: '1234-5679' }
    },
    { title: 'Imaginary unmatched reference', containerTitle: 'Unlisted imaginary review' },
    {
      title: 'Imaginary conflicting reference',
      containerTitle: 'Imaginary IPC Review 0',
      typeFields: { issn: '0378-5955' }
    }
  ].map((paper) => literatureItemInputSchema.parse({ itemType: 'journalArticle', ...paper }))
  for (const item of papers)
    await page.evaluate(
      (item) => window.api.literature.transact({ kind: 'create-item', item }),
      item
    )
  await openJournals(page)
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Journal alignment', exact: true }).click()
  await page.getByRole('button', { name: 'Check library', exact: true }).click()
  await expect(
    page.getByText('Matched: 2 · Unmatched: 1 · Conflicts: 1', { exact: true })
  ).toBeVisible()
  await page.getByRole('combobox', { name: 'Match status', exact: true }).click()
  await page.getByRole('option', { name: 'Matched', exact: true }).click()
  await expect(
    page.getByText('Matched by journal name or abbreviation', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('Matched by ISSN', { exact: true })).toBeVisible()
  const second = await app.openAdditionalRenderer()
  await second.evaluate(
    (item) => window.api.literature.transact({ kind: 'create-item', item }),
    literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Imaginary newly added reference',
      containerTitle: 'Imaginary IPC Review 0'
    })
  )
  await expect(
    page.getByText(
      'References or journal data may have changed. Recheck the library before using these results.',
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Match status', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Recheck library', exact: true }).click()
  await expect(
    page.getByText('Matched: 3 · Unmatched: 1 · Conflicts: 1', { exact: true })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Imaginary name-only reference', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Journals', exact: true })).not.toBeVisible()
  await expect(
    page.getByRole('dialog', { name: 'Imaginary name-only reference', exact: true })
  ).toBeVisible()
})

test('confirms one reference through the UI, refreshes another window, and persists across restart', async ({
  app
}) => {
  test.setTimeout(120_000)
  const page = await app.completeOnboarding()
  await page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
  const draft = await prepare(page, 1, 'Invented confirmation source')
  await page.evaluate(
    (draft) => window.api.literature.journals({ action: 'commit', ...draft, skipProblems: false }),
    draft
  )
  const ids: string[] = []
  for (const title of ['Synthetic selected reference', 'Synthetic separate reference']) {
    const result = await page.evaluate(
      (item) =>
        window.api.literature.transact({ kind: 'create-item', item, duplicatePolicy: 'separate' }),
      literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title,
        containerTitle: 'Unlisted imaginary review'
      })
    )
    ids.push(result.id)
  }
  const second = await app.openAdditionalRenderer()
  await second.evaluate(() => {
    const state = window as typeof window & { bindingEvents?: number }
    state.bindingEvents = 0
    window.api.literature.onChanged(() => {
      state.bindingEvents! += 1
    })
  })
  await openJournals(page)
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Journal alignment', exact: true }).click()
  await page.getByRole('button', { name: 'Check library', exact: true }).click()
  const row = page.getByRole('row').filter({
    has: page.getByRole('button', { name: 'Synthetic selected reference', exact: true })
  })
  await row.getByRole('button', { name: 'Find journal candidates', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Search journal candidates', exact: true })
    .fill('Imaginary IPC Review')
  await page.getByRole('button', { name: 'Find journal candidates', exact: true }).last().click()
  await page.getByRole('button', { name: 'Choose journal', exact: true }).click()
  await expect(page.getByLabel('Confirm journal association', { exact: true })).toContainText(
    'Synthetic selected reference'
  )
  await page.getByRole('button', { name: 'Confirm journal association', exact: true }).click()
  await expect
    .poll(() =>
      second.evaluate(() => (window as typeof window & { bindingEvents?: number }).bindingEvents)
    )
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Synthetic selected reference', exact: true }).click()
  await expect(
    page
      .getByRole('dialog', { name: 'Synthetic selected reference', exact: true })
      .getByText('Band 0', { exact: true })
  ).toBeVisible()
  const resolve = (active: Page): Promise<JournalResult> =>
    active.evaluate(
      (ids) =>
        window.api.literature.journals({
          action: 'resolve',
          identities: ids.map((itemId) => ({
            itemId,
            name: 'Unlisted imaginary review',
            aliases: [],
            issns: []
          }))
        }),
      ids
    )
  expect((await resolve(second)).matches?.map(({ status }) => status)).toEqual([
    'matched',
    'missing'
  ])
  const restored = await app.restart()
  expect((await resolve(restored)).matches?.map(({ status }) => status)).toEqual([
    'matched',
    'missing'
  ])
  await openJournals(restored)
  await restored.getByRole('button', { name: 'More actions', exact: true }).click()
  await restored.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(
    restored.getByText('Manual confirmations to remove: 1', { exact: true })
  ).toBeVisible()
  await expect(restored.getByText('Journal identities to remove: 1', { exact: true })).toBeVisible()
  await restored.getByRole('button', { name: 'Cancel', exact: true }).click()
  await restored.getByRole('button', { name: 'More actions', exact: true }).click()
  await restored.getByRole('menuitem', { name: 'Journal alignment', exact: true }).click()
  await restored.getByRole('button', { name: 'Check library', exact: true }).click()
  await restored.getByRole('combobox', { name: 'Match status', exact: true }).click()
  await restored.getByRole('option', { name: 'Matched', exact: true }).click()
  await expect(restored.getByText('Manually confirmed journal', { exact: true })).toBeVisible()
  await restored.getByRole('button', { name: 'Remove journal confirmation', exact: true }).click()
  await restored.getByRole('button', { name: 'Confirm journal association', exact: true }).click()
  expect((await resolve(restored)).matches?.map(({ status }) => status)).toEqual([
    'missing',
    'missing'
  ])
})
