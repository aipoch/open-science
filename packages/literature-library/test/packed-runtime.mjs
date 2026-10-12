import assert from 'node:assert/strict'
import { LibraryTransaction, normalizedIdentifiers } from '@aipoch/literature-library'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import {
  createLiteratureCreation,
  createLiteratureDetailController
} from '@aipoch/literature-library/client'
await writeFile('memory-store.mjs', stripTypeScriptTypes(await readFile('memory-store.ts', 'utf8')))
const { memoryLibrary } = await import('./memory-store.mjs')
const db = memoryLibrary({ LibraryTransaction, normalizedIdentifiers, literatureItemInputSchema })
const input = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Independent consumer',
  identifiers: [{ scheme: 'doi', value: '10.1000/pack', isPrimary: true }]
})
const receipt = await db.run((owner) => owner.importItems([input, input]))
assert.equal(db.state.items.size, 1)
const id = [...db.state.items.keys()][0]
const controller = createLiteratureDetailController((key) => db.store.item(key))
assert.equal((await controller.read(id)).item.title, input.title)
let creates = 0
const creation = createLiteratureCreation({
  transact: async () => {
    creates++
    return { kind: 'item', id }
  },
  read: (key) => db.store.item(key)
})
await creation.complete({ item: input, duplicatePolicy: 'reuse' }, async () => {
  throw Error('Unexpected PDF')
})
await creation.complete({ duplicatePolicy: 'reuse' }, async () => {
  throw Error('Unexpected PDF')
})
assert.equal(creates, 1)
assert.ok(receipt)
