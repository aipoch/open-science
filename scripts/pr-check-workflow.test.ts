import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  'continue-on-error'?: boolean
  if?: string
  name?: string
  run?: string
}

type Workflow = {
  jobs: Record<string, { steps?: WorkflowStep[] }>
}

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/pr-check.yml'), 'utf8')
) as Workflow

const getStep = (name: string): WorkflowStep => {
  const step = workflow.jobs.verify?.steps?.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing PR Check step: ${name}`)
  return step
}

describe('PR Check platform test coverage', () => {
  it('runs the full advisory suite on Ubuntu only', () => {
    const step = getStep('Test (advisory)')

    expect(step.if).toBe("matrix.os == 'ubuntu-latest'")
    expect(step['continue-on-error']).toBe(true)
    expect(step.run).toBe('npm run test')
  })

  it('hard-gates the focused Windows test suite', () => {
    const step = getStep('Test Windows-specific behavior')

    expect(step.if).toBe("matrix.os == 'windows-latest'")
    expect(step['continue-on-error']).toBeUndefined()
    for (const testFile of [
      'src/main/windows.test.ts',
      'src/main/windows-icon-assets.test.ts',
      'src/main/windows-powershell.test.ts',
      'src/main/file-save.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/notebook/micromamba-cache-powershell.test.ts',
      'src/main/notebook/micromamba-cache-acl.integration.test.ts'
    ]) {
      expect(step.run).toContain(testFile)
    }
  })

  it('hard-gates the Windows notebook shell integration test', () => {
    const step = getStep('Test Windows notebook shell behavior')

    expect(step.if).toBe("matrix.os == 'windows-latest'")
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.run).toBe('npx vitest run src/main/notebook/windows-shell.integration.test.ts')
  })

  it('hard-gates the Windows notebook shell service timeout', () => {
    const step = getStep('Test Windows notebook shell service timeout')

    expect(step.if).toBe("matrix.os == 'windows-latest'")
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.run).toContain('src/main/notebook/runtime-service.test.ts')
    expect(step.run).toContain('--testNamePattern')
    expect(step.run).toContain(
      'kills a command that outlasts the timeout and returns a non-normal result'
    )
  })
})
