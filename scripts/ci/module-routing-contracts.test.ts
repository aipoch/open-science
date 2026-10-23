import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAffectedTestPlan } from './module-test-impact.mjs'
import { createPackageTestPlan } from './package-test-impact.mjs'

const root = resolve(__dirname, '../..')
const noGraph = { status: 'not-used', testFiles: [] }

function selectiveTests(path: string): string[] {
  const plan = createAffectedTestPlan([{ path, status: 'modified' }], noGraph)
  expect(plan.mode, path).toBe('selective')
  return plan.testFiles
}

// Dynamic contracts that no import edge expresses stay pinned to the module that owns them.
describe('explicit downstream behavior contracts at reviewed boundaries', () => {
  it.each([
    [
      'src/main/artifacts/provenance-repository.ts',
      [
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/renderer/src/pages/workspace/SessionReproducibilityDialog.test.tsx',
        'src/renderer/src/pages/workspace/artifact-environment-lock-store.test.ts',
        'src/renderer/src/pages/workspace/PreviewFileSurface.test.tsx',
        'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts'
      ]
    ],
    [
      'src/main/compute/compute-service.ts',
      [
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/cancellation-runtime.integration.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/notebook/host-compute.integration.test.ts'
      ]
    ],
    [
      'src/main/settings/service.ts',
      [
        'src/renderer/src/stores/settings-store.test.ts',
        'src/renderer/src/stores/settings-runtime-slice.test.ts',
        'src/main/settings/service.providers.test.ts',
        'src/main/settings/service.connectors.test.ts',
        'src/main/settings/runtime-application-commands.test.ts'
      ]
    ],
    [
      'src/main/settings/backend-resolver.ts',
      [
        'src/main/settings/backend-resolver.test.ts',
        'src/main/agent-framework/claude-code.test.ts',
        'src/main/agent-framework/codex.test.ts',
        'src/main/agent-framework/opencode.test.ts'
      ]
    ],
    [
      'src/main/reviewer/orchestrator.ts',
      [
        'src/renderer/src/stores/review-store.test.ts',
        'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
        'src/renderer/src/reviewer-paged-preview/main.test.ts',
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/main/delegation/delegated-review-evidence.test.ts'
      ]
    ],
    [
      'src/main/reviewer/paged-preview-electron.ts',
      [
        'src/renderer/src/stores/review-store.test.ts',
        'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
        'src/renderer/src/reviewer-paged-preview/main.test.ts',
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/main/delegation/delegated-review-evidence.test.ts'
      ]
    ],
    [
      'src/renderer/src/stores/session-store.ts',
      [
        'src/renderer/src/hooks/useLifecycleSync.test.tsx',
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx'
      ]
    ]
  ])('%s selects its pinned contracts', (path, expected) => {
    expect(selectiveTests(path)).toEqual(expect.arrayContaining(expected))
  })
})

describe('Skill package routing', () => {
  const registry = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/package-test-boundaries.json'), 'utf8')
  )

  it('excludes unchanged upstream Skill units for host edits while preserving conservative fallback', () => {
    for (const path of [
      'src/main/skills/host-skills-service.ts',
      'src/main/skill-marketplace/service.ts',
      'src/main/skill-marketplace/installation.ts',
      'src/renderer/src/pages/settings/SkillEditor.tsx'
    ]) {
      const plan = createPackageTestPlan([path], registry)
      expect(plan.selected).not.toContain('packages/skills')
      expect(plan.excluded).toContain('packages/skills')
    }
    expect(
      createPackageTestPlan(['packages/skills/src/skill-authoring-service.ts'], registry).selected
    ).toEqual(['packages/skills'])
    for (const path of ['package-lock.json', 'unknown-input']) {
      expect(createPackageTestPlan([path], registry).selected).toContain('packages/skills')
    }
    const module = JSON.parse(
      readFileSync(resolve(root, 'scripts/ci/module-impact/skill_package.json'), 'utf8')
    )
    expect(module.testFiles.consumer).toContain('src/main/skills/host-skills-service.test.ts')
    expect([...module.testFiles.contract, ...module.testFiles.consumer]).toContain(
      'src/main/skills/catalog.test.ts'
    )
  })
})
