/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import {
  LiteratureSmartCollections,
  ClassificationEvaluationError
} from '@aipoch/literature-screening'
import { formatSmartRule } from '@aipoch/literature-screening/rules'
// The consumer supplies its own in-memory storage adapter; no repository files or ORM exist here.
await writeFile('memory-store.mjs', stripTypeScriptTypes(await readFile('memory-store.ts', 'utf8')))
const { MemoryScreeningStore } = await import('./memory-store.mjs')
const store = new MemoryScreeningStore()
store.seed('first')
store.seed('second', 'Second')
let fail = true
const seen = []
const classifier = {
  policy: async () => ({ key: 'stable-policy', configured: true, model: 'fixture' }),
  classifyLiterature: async (input) => {
    seen.push(input.title)
    const runId = input.usageContext.runId
    store.usage.set(runId, {
      inputTokens: 0,
      outputTokens: 0,
      incomplete: true,
      scenarios: [{ scenario: input.usageContext.scenario }]
    })
    if (fail && input.title === 'Second') throw new ClassificationEvaluationError('network')
    return {
      verdict: 'match',
      model: 'fixture',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  }
}
const wait = async (owner, id, state) => {
  for (let i = 0; i < 100; i++) {
    const view = await owner.view(id)
    if (view.run?.state === state) return view.run
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw Error('Screening did not reach ' + state)
}
let owner = new LiteratureSmartCollections(
  async () => store.database,
  classifier,
  () => {}
)
try {
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Trials',
    scope: { kind: 'library' },
    description: formatSmartRule({ description: '', inclusion: 'Trials', exclusion: '' })
  })
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  const failed = await wait(owner, id, 'failed')
  assert.equal(failed.done, 2)
  const completed = structuredClone(store.items.get(`${failed.id}:first`))
  assert.equal(completed.state, 'done')
  await owner.dispose()
  owner = new LiteratureSmartCollections(
    async () => store.database,
    classifier,
    () => {}
  )
  fail = false
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'resume',
    runId: failed.id,
    offset: 0
  })
  assert.equal((await wait(owner, id, 'completed')).id, failed.id)
  assert.deepEqual(store.items.get(`${failed.id}:first`), completed)
  assert.deepEqual(seen, ['Research', 'Second', 'Second'])
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'first',
    decision: 'exclude',
    offset: 0
  })
  assert.deepEqual(await owner.members(id), ['second'])
} finally {
  await owner.dispose()
}
console.log('Installed screening consumer: interrupted batch recovery and manual decisions passed')
