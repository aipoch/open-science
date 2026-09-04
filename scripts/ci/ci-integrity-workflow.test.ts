import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  id?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<
    string,
    {
      name?: string
      permissions?: Record<string, string>
      'runs-on'?: string
      steps?: Step[]
      'timeout-minutes'?: number
    }
  >
  on?: Record<string, unknown>
  permissions?: Record<string, string>
}

const workflow = load(
  readFileSync(join(process.cwd(), '.github/workflows/ci-integrity.yml'), 'utf8')
) as Workflow
const job = workflow.jobs.integrity

const step = (name: string): Step => {
  const result = job?.steps?.find((candidate) => candidate.name === name)
  if (!result) throw new Error(`Missing CI Integrity step: ${name}`)
  return result
}

describe('CI Integrity workflow', () => {
  it('runs the stable trusted check for pull requests and merge groups', () => {
    expect(workflow.on?.pull_request_target).toEqual({
      branches: ['main'],
      types: ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']
    })
    expect(workflow.on).toHaveProperty('merge_group')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group:
        'ci-integrity-${{ github.event.pull_request.number || github.event.merge_group.head_ref || github.ref }}',
      'cancel-in-progress': true
    })
    expect(job).toMatchObject({
      name: 'CI Integrity',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 5
    })
  })

  it('checks out only the trusted base revision with immutable actions', () => {
    expect(step('Checkout trusted base')).toMatchObject({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        'fetch-depth': 0,
        'persist-credentials': false,
        ref: '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}'
      }
    })
    expect(step('Setup Node')).toMatchObject({
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': 22, cache: 'npm' }
    })
    expect(step('Install trusted parsing toolchain').run).toBe('npm ci --ignore-scripts --no-audit')
  })

  it('fetches PR objects without checking out or executing the head revision', () => {
    const revisions = step('Resolve inspected revisions')

    expect(revisions.id).toBe('revisions')
    expect(revisions.run).toContain('refs/pull/${PR_NUMBER}/head')
    expect(revisions.run).toContain('git rev-parse FETCH_HEAD')
    expect(revisions.run).not.toContain('git checkout')
    expect(revisions.run).not.toContain('git switch')
    expect(step('Inspect CI-sensitive changes').run).toBe(
      'node scripts/ci/check-ci-integrity.mjs --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
  })

  it('revalidates PR metadata with the trusted base policy instead of restarting PR Gate', () => {
    expect(step('Validate pull request metadata')).toMatchObject({
      env: {
        EVENT_NAME:
          "${{ github.event_name == 'pull_request_target' && 'pull_request' || github.event_name }}",
        PR_TITLE: '${{ github.event.pull_request.title }}',
        POLICY_SCOPE: 'title'
      },
      run: 'node scripts/ci/check-pr-policy.mjs'
    })
  })
})
