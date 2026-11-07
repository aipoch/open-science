import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { parseOutputArgument, verifyArchive, verifyTests } from './agent-harness-acceptance.mjs'

const passingReport = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ name: '/isolated/recovery.test.ts', assertionResults: [{ status: 'passed' }] }]
}
const report = (): typeof passingReport => structuredClone(passingReport)

describe('standalone acceptance evidence', () => {
  it('accepts npm 10 Windows forwarding of the output value', () => {
    expect(parseOutputArgument([], 'default')).toBe('default')
    expect(parseOutputArgument(['--output', 'evidence'], 'default')).toBe('evidence')
    expect(parseOutputArgument(['evidence'], 'default')).toBe('evidence')
    expect(() => parseOutputArgument(['--output'], 'default')).toThrow()
    expect(() => parseOutputArgument(['--skip-tests'], 'default')).toThrow()
  })

  it('rejects empty, skipped, failed and omitted tests instead of producing a passing receipt', () => {
    expect(verifyTests(report(), ['recovery.test.ts'])).toEqual({
      files: 1,
      tests: 1,
      passed: 1,
      skipped: 0
    })
    for (const broken of [
      { ...report(), numTotalTests: 0, numPassedTests: 0 },
      { ...report(), numPassedTests: 0, numPendingTests: 1 },
      { ...report(), success: false, numPassedTests: 0, numFailedTests: 1 },
      { ...report(), testResults: [] },
      {
        ...report(),
        testResults: [
          { name: '/isolated/recovery.test.ts', assertionResults: [{ status: 'pending' }] }
        ]
      }
    ])
      expect(() => verifyTests(broken, ['recovery.test.ts'])).toThrow()
  })

  it('accepts Windows report paths without weakening the required file inventory', () => {
    const value = report()
    value.testResults[0].name = 'C:\\isolated\\recovery.test.ts'
    expect(verifyTests(value, ['recovery.test.ts']).tests).toBe(1)
    expect(() => verifyTests(value, ['another.test.ts'])).toThrow()
  })

  it('rejects changed archive bytes and undeclared packed files', () => {
    const bytes = Buffer.from('packed candidate')
    const archive = {
      filename: 'candidate.tgz',
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      files: [{ path: 'package.json' }, { path: 'dist/index.js' }]
    }
    expect(verifyArchive(archive, bytes, ['dist/index.js', 'package.json']).sha256).toBe(
      createHash('sha256').update(bytes).digest('hex')
    )
    expect(() =>
      verifyArchive(archive, Buffer.from('changed'), ['dist/index.js', 'package.json'])
    ).toThrow()
    expect(() => verifyArchive(archive, bytes, ['package.json'])).toThrow()
    expect(() =>
      verifyArchive({ ...archive, integrity: 'sha512-invalid' }, bytes, [
        'dist/index.js',
        'package.json'
      ])
    ).toThrow()
  })

  it('keeps cross-platform CI targets, the minimum runtime and failed evidence without release authority', () => {
    const workflow = load(readFileSync('.github/workflows/agent-harness.yml', 'utf8')) as {
      permissions: Record<string, string>
      jobs: {
        accept: {
          strategy: { matrix: { runner: string[]; node: string[] } }
          steps: { run?: string; if?: string; uses?: string }[]
        }
      }
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.accept.strategy.matrix).toEqual({
      runner: ['ubuntu-24.04', 'ubuntu-24.04-arm', 'windows-latest', 'macos-15'],
      node: ['22.13.0', '24']
    })
    expect(
      workflow.jobs.accept.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
        ?.if
    ).toBe('always()')
    const commands = workflow.jobs.accept.steps
      .flatMap((step) => (step.run ? [step.run] : []))
      .join('\n')
    expect(commands).toContain('npm run check:agent-harness-standalone')
    expect(commands).not.toMatch(/npm publish|git push|gh release|--skip-tests/)
  })
})
