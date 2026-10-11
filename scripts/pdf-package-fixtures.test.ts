import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps host PDF translation regression fixtures in the independent package suite', () => {
  const host = 'test/fixtures/pdf-translation'
  const owner = 'packages/pdf-translation/test/fixtures'
  const shared = readdirSync(host)
    .filter((name) => /\.jsonl?$/.test(name))
    .sort()
  for (const name of shared) {
    expect(readFileSync(join(owner, name), 'utf8'), name).toBe(
      readFileSync(join(host, name), 'utf8')
    )
  }
})
