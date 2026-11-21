import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { AGENT_FRAMEWORK_ID_VALUES } from '../../src/shared/agent-framework-id'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(
  readFileSync(resolve(root, 'scripts/ci/acp-framework-coverage.json'), 'utf8')
) as {
  baseline: string[]
  representative: { framework: string; files: string[] }
  specialized: Record<string, string[]>
}

describe('ACP framework coverage manifest', () => {
  it('keeps every registered framework in specialized coverage', () => {
    expect(Object.keys(manifest.specialized).sort()).toEqual([...AGENT_FRAMEWORK_ID_VALUES].sort())
  })

  it('keeps all declared coverage files in the repository', () => {
    const files = [
      ...manifest.baseline,
      ...manifest.representative.files,
      ...Object.values(manifest.specialized).flat()
    ]
    expect(files.every((file) => existsSync(resolve(root, file)))).toBe(true)
  })

  it('uses one representative external framework without making it a separate entry point', () => {
    expect(manifest.representative.framework).toBe('claude-code')
    expect(manifest.representative.files.length).toBeGreaterThan(0)
  })
})
