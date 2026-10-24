import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { createPackageTestPlan } from './package-test-impact.mjs'

const root = resolve(__dirname, '../..')

// Dynamic contracts that no import edge expresses stay pinned to their owning modules.

it('requires full validation for the expanded research publication boundary', () => {
  const module = loadModuleImpactManifest().modules.artifact_provenance
  const reason =
    'Published research versions now share content-authority, persistence and replay ports with artifact publication; this expanded mixed owner requires full validation of its package, observation and recovery consumers.'
  expect(module.fullTestReason).toBe(reason)
  const plan = createAffectedTestPlan(
    [{ path: 'src/main/artifacts/provenance-repository.ts', status: 'modified' }],
    { status: 'not-used', testFiles: [] }
  )
  expect(plan.mode).toBe('full')
  expect(plan.reasonChains).toEqual([`artifact_provenance -> ${reason} -> full`])
  expect(plan.testFiles).toEqual([])
  expect(module.testFiles.consumer).toEqual(
    expect.arrayContaining([
      'src/renderer/src/lib/acp/workspace-events.test.ts',
      'src/renderer/src/pages/workspace/SessionReproducibilityDialog.test.tsx',
      'src/renderer/src/pages/workspace/artifact-environment-lock-store.test.ts',
      'src/renderer/src/pages/workspace/PreviewFileSurface.test.tsx',
      'src/main/session-persistence/artifact-finalization-recovery.integration.test.ts',
      'src/main/session-package/research-reproduction.integration.test.ts',
      'src/main/composition/session-packages.lifecycle.test.ts'
    ])
  )
})

it('requires full compute validation while preserving downstream research contracts', () => {
  {
    const plan = createAffectedTestPlan(
      [{ path: 'src/main/compute/compute-service.ts', status: 'modified' }],
      { status: 'not-used', testFiles: [] }
    )
    const module = loadModuleImpactManifest().modules.compute_service
    const reason =
      'The compute_service owner retains 41 explicit research consumer obligations beyond its reviewed source-derived edges, including local-rpc-server.managed-execution.test.ts, managed-auxiliary-output.test.ts, managed-execution-collection.integration.test.ts. 36 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    expect(module.fullTestReason).toBe(reason)
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains).toEqual([`compute_service -> ${reason} -> full`])
    expect(plan.testFiles).toEqual([])
    expect(Object.values(module.testFiles).flat()).toEqual(
      expect.arrayContaining([
        'src/main/compute/compute-job-lifecycle.test.ts',
        'src/main/compute/cancellation-runtime.integration.test.ts',
        'src/main/compute/job-deletion-runtime-isolation.test.ts',
        'src/main/compute/ipc.test.ts',
        'src/main/notebook/host-compute.integration.test.ts'
      ])
    )
  }
})

it('requires full reviewer validation while preserving downstream research contracts', () => {
  for (const path of [
    'src/main/reviewer/orchestrator.ts',
    'src/main/reviewer/paged-preview-electron.ts'
  ]) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'not-used',
      testFiles: []
    })
    const module = loadModuleImpactManifest().modules.reviewer_orchestrator
    const reason =
      'The reviewer_orchestrator owner retains 4 explicit research consumer obligations beyond its reviewed source-derived edges, including research-material-authority.test.ts, run-observation-external-port.test.ts, inspection.test.ts. 3 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    expect(module.fullTestReason).toBe(reason)
    expect(plan.mode, path).toBe('full')
    expect(plan.reasonChains, path).toEqual([`reviewer_orchestrator -> ${reason} -> full`])
    expect(plan.testFiles, path).toEqual([])
    expect(Object.values(module.testFiles).flat(), path).toEqual(
      expect.arrayContaining([
        'src/renderer/src/stores/review-store.test.ts',
        'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx',
        'src/renderer/src/reviewer-paged-preview/main.test.ts',
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/main/delegation/delegated-review-evidence.test.ts'
      ])
    )
  }
})

it('requires full settings service validation and selective provider contracts', () => {
  {
    const plan = createAffectedTestPlan(
      [{ path: 'src/main/settings/service.ts', status: 'modified' }],
      { status: 'not-used', testFiles: [] }
    )
    const module = loadModuleImpactManifest().modules.settings_service_facade
    const reason =
      'The settings_service_facade owner retains 1 explicit research consumer obligation beyond its reviewed source-derived edges, including managed-research-acceptance.macos.integration.test.ts. 1 consumer cone has opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full main_runtime validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    expect(module.fullTestReason).toBe(reason)
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains).toEqual([`settings_service_facade -> ${reason} -> full`])
    expect(plan.testFiles).toEqual([])
    expect(Object.values(module.testFiles).flat()).toEqual(
      expect.arrayContaining([
        'src/renderer/src/stores/settings-store.test.ts',
        'src/renderer/src/stores/settings-runtime-slice.test.ts',
        'src/main/settings/service.providers.test.ts',
        'src/main/settings/service.connectors.test.ts',
        'src/main/settings/runtime-application-commands.test.ts'
      ])
    )
  }
  {
    const plan = createAffectedTestPlan(
      [{ path: 'src/main/settings/backend-resolver.ts', status: 'modified' }],
      { status: 'not-used', testFiles: [] }
    )
    const module = loadModuleImpactManifest().modules.settings_provider_resolution
    expect(module.fullTestReason).toBeUndefined()
    expect(plan.mode).toBe('selective')
    expect(plan.modules).toContain('settings_provider_resolution')
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/settings/backend-resolver.test.ts',
        'src/main/agent-framework/claude-code.test.ts',
        'src/main/agent-framework/codex.test.ts',
        'src/main/agent-framework/opencode.test.ts'
      ])
    )
  }
})

it('requires full session renderer validation while preserving downstream research contracts', () => {
  for (const path of ['src/renderer/src/stores/session-store.ts']) {
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'not-used',
      testFiles: []
    })
    const module = loadModuleImpactManifest().modules.session_renderer
    const reason =
      'The session_renderer owner retains 2 explicit research consumer obligations beyond its reviewed source-derived edges, including index-fatal-errors.test.ts, index-startup-failure.test.ts. 2 consumer cones have opaque runtime access, so their process, IPC, filesystem or renderer effects cannot be proven independent. Retain full renderer_view validation until these research consumer boundaries are reviewed; preserve all existing contracts and platform lanes.'
    expect(module.fullTestReason).toBe(reason)
    expect(plan.mode, path).toBe('full')
    expect(plan.reasonChains, path).toEqual([`session_renderer -> ${reason} -> full`])
    expect(plan.testFiles, path).toEqual([])
    expect(Object.values(module.testFiles).flat(), path).toEqual(
      expect.arrayContaining([
        'src/renderer/src/hooks/useLifecycleSync.test.tsx',
        'src/renderer/src/lib/acp/workspace-events.test.ts',
        'src/renderer/src/pages/workspace/WorkspacePage.send-gate.test.tsx'
      ])
    )
  }
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
