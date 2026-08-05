import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  'continue-on-error'?: boolean
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
) as { bundleOrder: string[]; laneBundles: Record<string, string>; laneOrder: string[] }

describe('PR Gate workflow', () => {
  it('is the only repository-owned pull request quality workflow', () => {
    for (const legacyWorkflow of [
      'pr-check.yml',
      'windows-path-portability.yml',
      'commit-message-check.yml'
    ]) {
      expect(
        existsSync(join(process.cwd(), '.github/workflows', legacyWorkflow)),
        `${legacyWorkflow} must not duplicate PR Gate`
      ).toBe(false)
    }
  })

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

  it('fans semantic lanes into the declared runner bundles', () => {
    expect(workflow.jobs.preflight.outputs).toEqual({
      base: '${{ steps.revisions.outputs.base }}',
      head: '${{ steps.revisions.outputs.head }}',
      lanes: '${{ steps.classify.outputs.lanes }}',
      plan: '${{ steps.classify.outputs.plan }}'
    })

    for (const bundle of manifest.bundleOrder) {
      expect(workflow.jobs[bundle], `missing job for ${bundle}`).toBeDefined()
      expect(workflow.jobs[bundle].needs).toBe('preflight')
      expect(workflow.jobs[bundle].if).toContain("needs.preflight.result == 'success'")
      expect(workflow.jobs[bundle].if).toContain(`'${bundle}'`)
    }

    for (const lane of manifest.laneOrder) {
      if (manifest.bundleOrder.includes(lane)) continue
      expect(workflow.jobs[lane], `lane ${lane} must execute through its bundle`).toBeUndefined()
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

  it('aggregates all deterministic bundles into the stable PR Gate job', () => {
    const gate = workflow.jobs.gate

    expect(gate.name).toBe('PR Gate')
    expect(gate.if).toBe('${{ always() }}')
    expect(gate.needs).toEqual(['preflight', ...manifest.bundleOrder])
    expect(gate.env).toEqual({
      PR_GATE_EXECUTION_MODE: 'bundles',
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

  it('shares dependency installation and Electron builds inside platform bundles', () => {
    for (const bundle of [
      'static',
      'unit',
      'coverage_macos',
      'windows_core',
      'macos_e2e',
      'windows_e2e',
      'linux_e2e'
    ]) {
      expect(
        workflow.jobs[bundle].steps?.filter(({ run }) => run === 'npm ci'),
        `${bundle} must install dependencies exactly once`
      ).toHaveLength(1)
    }

    const macosRuns = workflow.jobs.macos_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(macosRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(macosRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey',
        'npm run test:e2e:workspace',
        'npm run test:e2e:accessibility',
        'npm run test:e2e:visual',
        'node scripts/ci/run-selected-release-e2e.mjs'
      ])
    )

    const windowsRuns = workflow.jobs.windows_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(windowsRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(windowsRuns).toEqual(
      expect.arrayContaining([
        'npm run test:e2e:journey',
        'npm run test:e2e:workspace',
        'npm run test:e2e:accessibility',
        'npm run test:e2e:visual',
        'node scripts/ci/run-selected-release-e2e.mjs'
      ])
    )

    const linuxRuns = workflow.jobs.linux_e2e.steps?.map(({ run }) => run).filter(Boolean)
    expect(linuxRuns?.filter((run) => run === 'npm run build:e2e')).toHaveLength(1)
    expect(linuxRuns).toEqual(
      expect.arrayContaining([
        'xvfb-run -a npm run test:e2e:journey',
        'xvfb-run -a npm run test:e2e:workspace',
        'xvfb-run -a npm run test:e2e:accessibility',
        'xvfb-run -a npm run test:e2e:visual',
        'xvfb-run -a node scripts/ci/run-selected-release-e2e.mjs'
      ])
    )
  })

  it('runs selected P0 journeys independently without starting unrelated platform bundles', () => {
    for (const [bundle, platform] of [
      ['macos_e2e', 'macos'],
      ['windows_e2e', 'windows'],
      ['linux_e2e', 'linux']
    ] as const) {
      const step = workflow.jobs[bundle].steps?.find(({ id }) => id === `e2e_release_${platform}`)

      expect(step?.env).toEqual({ PR_GATE_LANES: '${{ needs.preflight.outputs.lanes }}' })
      for (const journey of [
        'storage_migration',
        'provider_bridge',
        'notebook_lifecycle',
        'remote_pairing',
        'artifact_provenance'
      ]) {
        expect(step?.if).toContain(`'e2e_${journey}_${platform}'`)
      }
    }
  })

  it('collects independent bundle failures before failing the shared runner', () => {
    for (const bundle of [
      'static',
      'unit',
      'windows_core',
      'macos_e2e',
      'windows_e2e',
      'linux_e2e'
    ]) {
      const enforce = workflow.jobs[bundle].steps?.find(({ name }) => name?.startsWith('Enforce'))
      expect(enforce, `${bundle} must enforce collected step outcomes`).toMatchObject({
        if: '${{ always() }}'
      })
      expect(enforce?.run).toContain('exit "$failed"')
    }

    for (const bundle of ['macos_e2e', 'windows_e2e', 'linux_e2e']) {
      for (const upload of workflow.jobs[bundle].steps?.filter(({ name }) =>
        name?.startsWith('Upload')
      ) ?? []) {
        expect(upload['continue-on-error'], `${upload.name} must not stop later E2E checks`).toBe(
          true
        )
      }
    }

    const portable = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Test complete portable suite (blocking)'
    )
    const renderer = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Test Renderer (blocking)'
    )
    const enforceUnit = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Enforce selected unit checks'
    )
    expect(portable?.['continue-on-error']).toBe(true)
    expect(renderer?.['continue-on-error']).toBe(true)
    expect(enforceUnit?.env).toEqual({
      UNIT_LINUX_OUTCOME: '${{ steps.unit_linux.outcome }}',
      UNIT_RENDERER_OUTCOME: '${{ steps.unit_renderer.outcome }}'
    })
    expect(enforceUnit?.run).toContain('check unit_linux "$UNIT_LINUX_OUTCOME"')
    expect(enforceUnit?.run).toContain('check unit_renderer "$UNIT_RENDERER_OUTCOME"')
  })

  it('preserves the complete portable suite and hard Windows contracts', () => {
    const portable = workflow.jobs.unit.steps?.find(
      ({ name }) => name === 'Test complete portable suite (blocking)'
    )
    expect(portable).toMatchObject({
      'continue-on-error': true,
      run: 'npm test'
    })

    expect(workflow.jobs.windows_core).toMatchObject({
      'runs-on': 'windows-latest',
      'timeout-minutes': 12
    })
    const runtime = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows-specific behavior'
    )
    for (const testFile of [
      'src/main/windows.test.ts',
      'src/main/windows-icon-assets.test.ts',
      'src/main/windows-powershell.test.ts',
      'src/main/file-save.test.ts',
      'src/main/specialist/repository.test.ts',
      'src/main/notebook/micromamba-cache-powershell.test.ts',
      'src/main/notebook/micromamba-cache-acl.integration.test.ts'
    ]) {
      expect(runtime?.run).toContain(testFile)
    }

    const shell = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell behavior'
    )
    const serviceTimeout = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows notebook shell service timeout'
    )
    expect(shell?.run).toBe('npx vitest run src/main/notebook/windows-shell.integration.test.ts')
    expect(serviceTimeout?.run).toContain('src/main/notebook/runtime-service.test.ts')
    expect(serviceTimeout?.run).toContain('--testNamePattern')

    const path = workflow.jobs.windows_core.steps?.find(
      ({ name }) => name === 'Test Windows path portability'
    )
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
      expect(path?.run).toContain(testFile)
    }
    expect(path?.run).toContain('--maxWorkers=1')
    expect(path?.run).toContain('--testTimeout=30000')
    expect(path?.run).toContain('--hookTimeout=30000')
  })

  it('checks only changed files for formatting', () => {
    const checkout = workflow.jobs.static.steps?.find(({ name }) => name === 'Checkout')
    const docs = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check Markdown formatting'
    )
    const format = workflow.jobs.static.steps?.find(({ name }) => name === 'Check formatting')

    expect(checkout?.with?.['fetch-depth']).toBe(0)
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
    const testStep = workflow.jobs.static.steps?.find(({ name }) => name === 'Test CLI and SDK')

    expect(testStep?.run).toContain('npx vitest run cli packages/open-science')
    expect(testStep?.run).toContain('npm run check:cli-package')
  })

  it('labels the existing cross-process checks as a shadow baseline', () => {
    const step = workflow.jobs.static.steps?.find(
      ({ name }) => name === 'Check interface contract baseline (shadow)'
    )

    expect(step).toBeDefined()
    for (const testFile of [
      'src/preload/index.test.ts',
      'src/preload/electron-renderer-contract-adapter.test.ts',
      'src/shared/renderer-contract.test.ts',
      'src/shared/renderer-contract-catalog.test.ts',
      'src/shared/renderer-surface-inventory.test.ts',
      'src/shared/renderer-surface-matrix.test.ts',
      'src/shared/web-rpc-contract.test.ts'
    ]) {
      expect(step?.run).toContain(testFile)
    }
    expect(manifest.laneOrder).not.toContain('unit_preload_contracts')
    expect(workflow.jobs).not.toHaveProperty('preload_contracts')
  })
})
