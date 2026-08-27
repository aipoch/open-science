import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020'
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

describe('figure-composer skill contract', () => {
  it('documents the registered helper and fail-closed workflow boundaries', async () => {
    const skill = await readFile(skillPath, 'utf8')

    expect(skill).toContain('helperModules: ["figure-composer"]')
    for (const name of helperExports) expect(skill).toMatch(new RegExp(`\\b${name}\\(`))
    for (const capability of ['llm', 'delegate', 'collect', 'artifacts', 'viewImage']) {
      expect(skill).toContain(`caps.${capability} !== true`)
    }
    expect(skill).toContain('artifactVersionInputs')
    expect(skill).toContain('producerRunId')
    expect(skill).toMatch(/maximum 3 review rounds/i)
    expect(skill).toMatch(/immutable Artifact Version/i)
    expect(skill).toMatch(/do not (?:read|import|exec|copy)/i)
    expect(skill).not.toMatch(/host\.(?:view_image|reasoning_model)/)
    expect(skill).not.toMatch(/derive_outline\(|fc_sdk\(/)
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

    it('emits an outline schema accepted by the application validator', () => {
      const schema = JSON.parse(
        execFileSync(
          python3 as string,
          [
            '-c',
            'import json; from kernel import figure_outline_schema; print(json.dumps(figure_outline_schema()))'
          ],
          { cwd: skillDir, encoding: 'utf8' }
        )
      )
      const validate = new Ajv2020({ allErrors: true }).compile(schema)
      const missingData = {
        claim: 'Claim',
        width_mm: 85,
        ncol: 1,
        row_heights_mm: [40],
        panels: [
          {
            letter: 'A',
            role: 'primary',
            message: 'Message',
            chart_family: 'bar',
            row: 0,
            col: 0,
            colspan: 1,
            ask: 'Show it'
          }
        ]
      }

      expect(validate(missingData)).toBe(false)
      expect(validate({ ...missingData, row_heights_mm: [], panels: [] })).toBe(false)
    })
  })
})
