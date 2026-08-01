import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type WorkflowJob = {
  'continue-on-error'?: boolean
  'runs-on'?: string
  steps?: WorkflowStep[]
  'timeout-minutes'?: number
}

type Workflow = {
  concurrency?: {
    'cancel-in-progress'?: boolean
    group?: string
  }
  jobs: Record<string, WorkflowJob>
  on?: {
    pull_request?: {
      branches?: string[]
      'paths-ignore'?: string[]
      types?: string[]
    }
    workflow_dispatch?: unknown
  }
  permissions?: Record<string, string>
}

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/windows-path-portability.yml'), 'utf8')
) as Workflow

const job = workflow.jobs.path_portability

const getStep = (name: string): WorkflowStep => {
  const step = job?.steps?.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing Windows path portability step: ${name}`)
  return step
}

describe('Windows path portability workflow', () => {
  it('runs for pull requests to main and supports manual dispatch', () => {
    expect(workflow.on?.pull_request).toMatchObject({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened']
    })
    expect(workflow.on?.pull_request?.['paths-ignore']).toEqual([
      '**/*.md',
      'docs/**',
      'LICENSE',
      '.gitignore'
    ])
    expect(workflow.on).toHaveProperty('workflow_dispatch')
  })

  it('is a bounded blocking job on a real Windows filesystem', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'windows-path-portability-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true
    })
    expect(job).toMatchObject({
      'runs-on': 'windows-latest',
      'timeout-minutes': 10
    })
    expect(job?.['continue-on-error']).toBeUndefined()
  })

  it('uses the locked Node toolchain', () => {
    expect(getStep('Checkout').uses).toBe('actions/checkout@v7')
    expect(getStep('Setup Node')).toMatchObject({
      uses: 'actions/setup-node@v7',
      with: { 'node-version': 22, cache: 'npm' }
    })
    expect(getStep('Install dependencies').run).toBe('npm ci')
  })

  it('hard-gates the focused filesystem path contracts without duplicating the full suite', () => {
    const run = getStep('Test Windows path portability').run

    for (const testFile of [
      'src/main/acp/workspace-path.test.ts',
      'src/main/file-save.test.ts',
      'src/main/notebook/run-document-data-paths.test.ts',
      'src/main/notebook/runtime-paths.test.ts',
      'src/main/session-persistence/conversation-export.test.ts',
      'src/main/session-persistence/data-path-roundtrip.test.ts',
      'src/main/settings/notebook-runtime-settings.test.ts',
      'src/main/settings/preferences.test.ts',
      'src/main/settings/shell-path.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/storage/data-path.test.ts',
      'src/main/storage/normalize-legacy-paths.test.ts',
      'src/main/storage/path-presence.test.ts'
    ]) {
      expect(run).toContain(testFile)
    }

    expect(run).toContain('--maxWorkers=1')
    expect(run).toContain('--testTimeout=30000')
    expect(run).toContain('--hookTimeout=30000')
    expect(run).not.toContain('npm test')
    expect(run).not.toContain('--shard')
  })
})
