import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const skillDir = dirname(fileURLToPath(import.meta.url))
const skillPath = join(skillDir, 'SKILL.md')
const contractPath = join(skillDir, 'test_kernel.py')
const descriptorPath = join(skillDir, 'open-science.json')
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip
const helperExports = (
  JSON.parse(readFileSync(descriptorPath, 'utf8')) as { helpers: Array<{ exports: string[] }> }
).helpers[0]!.exports

describe('paper-narrative skill contract', () => {
  it('documents deterministic helpers and the reviewed Host workflow boundary', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('helperModules: ["paper-narrative"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\b`))
    expect(skill).toContain('host.llm(')
    expect(skill).toContain('host.delegate(')
    expect(skill).toContain('outputSchema')
    expect(skill).toMatch(/immutable .*Artifact Version/i)
    expect(skill).toMatch(/model-generated.*requires human review/i)
    expect(skill).toMatch(/figure-composer/i)
    expect(skill).toContain('acceptedMissingPanelRecommendations')
    expect(skill).toContain('publishedMissingAnalysisVersionIdsByRecommendation')
    expect(skill).toMatch(/reshape only affected arc figures/i)
    expect(skill).not.toMatch(/reshape every arc figure/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/pn_sdk\(|derive_paper_brief\(|host\.reasoning_model/)
  })

  pythonGate('Python helper', () => {
    it('passes the public-interface harness', () => {
      expect(() =>
        execFileSync(python3 as string, [contractPath], {
          cwd: skillDir,
          timeout: 15_000
        })
      ).not.toThrow()
    })
  })
})
