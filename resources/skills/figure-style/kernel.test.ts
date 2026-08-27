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

describe('figure-style skill contract', () => {
  it('documents the registered helper without exposing its implementation', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('helperModules: ["figure-style"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    expect(skill).toMatch(/data shape/i)
    expect(skill).toMatch(/return/i)
    expect(skill).toMatch(/error/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/(?:open|read_text|read)\([^\n]*kernel\.py/i)
    expect(skill).not.toMatch(/(?:sys\.path|importlib|spec_from_file|runpy)/i)
  })

  pythonGate('Python helper', () => {
    it('passes the public-interface harness', () => {
      expect(() =>
        execFileSync(python3 as string, [contractPath], {
          cwd: skillDir,
          env: { ...process.env, MPLBACKEND: 'Agg' },
          timeout: 15_000
        })
      ).not.toThrow()
    })
  })
})
