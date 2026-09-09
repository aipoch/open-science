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
