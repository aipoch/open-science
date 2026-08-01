import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = {
  env?: Record<string, string>
  if?: string
  name?: string
  needs?: string | string[]
  outputs?: Record<string, string>
  'runs-on'?: string
  steps?: Step[]
  'timeout-minutes'?: number
}

type Workflow = {
  concurrency?: { 'cancel-in-progress'?: boolean; group?: string }
  jobs: Record<string, Job>
  on?: {
    merge_group?: { types?: string[] }
    pull_request?: { branches?: string[]; 'paths-ignore'?: string[]; types?: string[] }
    workflow_dispatch?: unknown
  }
  permissions?: Record<string, string>
}

const workflowText = readFileSync(join(process.cwd(), '.github/workflows/pr-gate.yml'), 'utf8')
const workflow = load(workflowText) as Workflow
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/ci/change-impact.json'), 'utf8')
) as { laneOrder: string[] }

describe('PR Gate workflow', () => {
  it('always emits the same gate without workflow-level path exclusions', () => {
    expect(workflow.on?.pull_request).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']
    })
    expect(workflow.on?.pull_request?.['paths-ignore']).toBeUndefined()
    expect(workflow.on?.merge_group).toEqual({ types: ['checks_requested'] })
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    expect(workflow.concurrency).toEqual({
      group:
        'pr-gate-${{ github.event.pull_request.number || github.event.merge_group.head_ref || github.ref }}',
      'cancel-in-progress': true
    })
  })

  it('fans every declared lane out directly from preflight', () => {
    expect(workflow.jobs.preflight.outputs).toEqual({
      base: '${{ steps.revisions.outputs.base }}',
      head: '${{ steps.revisions.outputs.head }}',
      lanes: '${{ steps.classify.outputs.lanes }}',
      plan: '${{ steps.classify.outputs.plan }}'
    })

    for (const lane of manifest.laneOrder) {
      expect(workflow.jobs[lane], `missing job for ${lane}`).toBeDefined()
      expect(workflow.jobs[lane].needs).toBe('preflight')
      expect(workflow.jobs[lane].if).toContain("needs.preflight.result == 'success'")
      expect(workflow.jobs[lane].if).toContain(`'${lane}'`)
    }
  })

  it('plans with the trusted base classifier and fails closed during bootstrap', () => {
    const prepare = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Prepare trusted classifier'
    )
    const classify = workflow.jobs.preflight.steps?.find(
      ({ name }) => name === 'Classify change impact'
    )

    expect(prepare?.run).toContain('git show "${BASE_SHA}:${file}"')
    expect(prepare?.run).toContain('source=bootstrap')
    expect(classify?.env).toMatchObject({
      TRUSTED_CLASSIFIER_DIR: '${{ steps.trusted_classifier.outputs.dir }}',
      TRUSTED_CLASSIFIER_SOURCE: '${{ steps.trusted_classifier.outputs.source }}'
    })
    expect(classify?.run).toContain(
      'node "$TRUSTED_CLASSIFIER_DIR/classify-pr-changes.mjs" --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
    expect(classify?.run).toContain("mode: 'full'")
    expect(classify?.run).not.toContain(
      'node scripts/ci/classify-pr-changes.mjs --base "$BASE_SHA" --head "$HEAD_SHA"'
    )
  })

  it('aggregates all deterministic lanes into the stable PR Gate job', () => {
    const gate = workflow.jobs.gate

    expect(gate.name).toBe('PR Gate')
    expect(gate.if).toBe('${{ always() }}')
    expect(gate.needs).toEqual(['preflight', ...manifest.laneOrder])
    expect(gate.env).toEqual({
      PR_GATE_NEEDS: '${{ toJSON(needs) }}',
      PR_GATE_PLAN: '${{ needs.preflight.outputs.plan }}',
      PREFLIGHT_RESULT: '${{ needs.preflight.result }}'
    })
    expect(gate.steps?.at(0)).toMatchObject({
      name: 'Checkout trusted gate evaluator',
      if: "${{ needs.preflight.result == 'success' }}",
      with: {
        'fetch-depth': 1,
        'persist-credentials': false,
        ref: '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || needs.preflight.outputs.base }}'
      }
    })
    expect(gate.steps?.at(-1)).toMatchObject({
      name: 'Evaluate deterministic gate from trusted base'
    })
    expect(gate.steps?.at(-1)?.run).toContain('node scripts/ci/evaluate-pr-gate.mjs')
    expect(gate.steps?.at(-1)?.run).toContain('Bootstrap-only strict evaluator')
    expect(workflowText).not.toMatch(/needs:.*(?:ai|codex|review)/i)
  })

  it('validates commit policy without coupling the gate to editable PR metadata', () => {
    const policy = workflow.jobs.policy.steps?.find(
      ({ name }) => name === 'Validate pull request policy'
    )

    expect(policy?.env).toEqual({
      BASE_SHA: '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
      EVENT_NAME: '${{ github.event_name }}',
      HEAD_SHA:
        '${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || github.sha }}',
      POLICY_SCOPE: 'commits'
    })
  })

  it('pins every third-party action to an immutable commit', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/)
      }
    }
  })

  it('checks only changed files for formatting', () => {
    const docsCheckout = workflow.jobs.docs.steps?.find(({ name }) => name === 'Checkout')
    const formatCheckout = workflow.jobs.format.steps?.find(({ name }) => name === 'Checkout')
    const docs = workflow.jobs.docs.steps?.find(({ name }) => name === 'Check Markdown formatting')
    const format = workflow.jobs.format.steps?.find(({ name }) => name === 'Check formatting')

    expect(docsCheckout?.with?.['fetch-depth']).toBe(0)
    expect(formatCheckout?.with?.['fetch-depth']).toBe(0)
    expect(docs).toMatchObject({
      env: {
        BASE_SHA: '${{ needs.preflight.outputs.base }}',
        HEAD_SHA: '${{ needs.preflight.outputs.head }}'
      },
      run: 'node scripts/ci/check-changed-format.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --kind markdown'
    })
    expect(format).toMatchObject({
      env: {
        BASE_SHA: '${{ needs.preflight.outputs.base }}',
        HEAD_SHA: '${{ needs.preflight.outputs.head }}'
      },
      run: 'node scripts/ci/check-changed-format.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --kind non-markdown'
    })
  })

  it('covers both root CLI and publishable SDK tests in the narrow lane', () => {
    const testStep = workflow.jobs.cli_sdk.steps?.find(({ name }) => name === 'Test CLI and SDK')

    expect(testStep?.run).toBe('npx vitest run cli packages/open-science')
  })

  it('labels the existing cross-process checks as a shadow baseline', () => {
    expect(workflow.jobs.interface_contracts.name).toBe('Interface contract baseline (shadow)')
  })
})
