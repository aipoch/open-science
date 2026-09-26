import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'
import { literatureCandidateInputSchema, literatureItemInputSchema } from '../src/shared/literature'

const library = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await page.getByRole('button', { name: 'All references', exact: true }).click()
}

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
    for (const page of [first, second, web]) await library(page)
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
  await library(page)
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
  await library(page)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add reference', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Add reference', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill('Manual creation regression')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Manual creation regression' })).toBeVisible()
})
