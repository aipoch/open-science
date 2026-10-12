import { createLiteratureCreation } from '@aipoch/literature-library/client'
import {
  literatureItemInputSchema,
  type LiteratureCatalogCommand,
  type LiteratureItemView
} from '@aipoch/literature-library/contracts'
import { expect, it, vi } from 'vitest'
const item = {
  id: 'saved',
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' })
} as LiteratureItemView
it('reuses the receipt and original destination and file after a link failure', async () => {
  const commands: LiteratureCatalogCommand[] = []
  let fail = true
  const owner = createLiteratureCreation<string>({
    transact: async (command) => {
      commands.push(command)
      if (command.kind === 'set-project-item' && fail) throw Error('offline')
      return { kind: 'item', id: 'saved' }
    },
    read: async () => item
  })
  const attach = vi.fn(async () => item)
  await expect(
    owner.complete(
      { item: item.item, duplicatePolicy: 'reuse', projectId: 'original', file: 'first.pdf' },
      attach
    )
  ).rejects.toThrow('offline')
  expect(owner.pendingId).toBe('saved')
  expect(owner.failurePhase).toBe('destination')
  expect(await owner.recoverPdfFailure()).toBeUndefined()
  fail = false
  await owner.complete(
    { item: item.item, duplicatePolicy: 'separate', projectId: 'changed', file: 'second.pdf' },
    attach
  )
  expect(commands.filter((c) => c.kind === 'create-item')).toHaveLength(1)
  expect(commands.filter((c) => c.kind === 'set-project-item').map((c) => c.projectId)).toEqual([
    'original',
    'original'
  ])
  expect(attach).toHaveBeenCalledExactlyOnceWith('first.pdf', 'saved')
  owner.reset()
  expect(owner.pendingId).toBeUndefined()
})
it('does not upload the PDF again if post-save reading or caller refresh is retried', async () => {
  const attach = vi.fn(async () => item),
    transact = vi.fn(async () => ({ kind: 'item' as const, id: 'saved' }))
  const owner = createLiteratureCreation<string>({ transact, read: async () => item })
  const intent = { item: item.item, duplicatePolicy: 'reuse' as const, file: 'one.pdf' }
  await owner.complete(intent, attach)
  await owner.complete(intent, attach)
  expect(attach).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledTimes(1)
})
it('recovers the created reference after PDF failure only when destination linking completed', async () => {
  const owner = createLiteratureCreation<string>({
    transact: async () => ({ kind: 'item', id: 'saved' }),
    read: async () => item
  })
  await expect(
    owner.complete({ item: item.item, duplicatePolicy: 'reuse', file: 'one.pdf' }, async () => {
      throw Error('upload')
    })
  ).rejects.toThrow('upload')
  expect(await owner.recoverPdfFailure()).toBe(item)
})
