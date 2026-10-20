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
    const hostContent = readFileSync(join(host, name), 'utf8')
    const packageContent = readFileSync(join(owner, name), 'utf8')
    if (name.endsWith('.jsonl')) {
      // Package-owned suites may add cases without changing the legacy host corpus.
      const cases = (content: string): unknown[] =>
        content
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      expect(cases(packageContent), name).toEqual(expect.arrayContaining(cases(hostContent)))
    } else {
      expect(JSON.parse(packageContent), name).toEqual(JSON.parse(hostContent))
    }
  }
})
