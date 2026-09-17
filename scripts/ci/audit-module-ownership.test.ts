import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditModuleOwnership } from './audit-module-ownership.mjs'
import {
  createAffectedTestPlan,
  createModuleTestPlan,
  modulesForPath
} from './module-test-impact.mjs'
import { isModuleOwnershipPath } from './module-ownership-paths.mjs'

const manifest = JSON.parse(readFileSync(resolve('scripts/ci/module-impact.json'), 'utf8'))
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const graph = { status: 'unavailable-manifest-only', testFiles: [] }

describe('complete module ownership', () => {
  it('requires an exact owner for every tracked source, test and runtime helper', () => {
    const result = auditModuleOwnership(manifest, files)
    expect(result.missing).toEqual([])
    expect(result.owned).toBe(result.files)
    expect(result.fullModules.map(({ id }) => id)).toEqual([
      'shared_application_contracts',
      'shared_conversation_contracts',
      'shared_workspace_contracts'
    ])
  })

  it.each([
    'ts',
    'tsx',
    'cjs',
    'mjs',
    'cc',
    'cpp',
    'h',
    'rs',
    'cs',
    'py',
    'R',
    'sh',
    'ps1',
    'css',
    'html',
    'json',
    'jsonl',
    'svg',
    'new-extension'
  ])(
    'detects an unregistered historical .%s file, even without a changed-file diff',
    (extension) => {
      const path = `packages/legacy/unregistered.${extension}`
      expect(isModuleOwnershipPath(path)).toBe(true)
      expect(auditModuleOwnership(manifest, [...files, path]).missing).toEqual([path])
    }
  )

  it('does not count consumer membership or colocated inference as explicit ownership', () => {
    const changed = structuredClone(manifest)
    const path = 'src/main/reviewer/correction.ts'
    changed.modules.reviewer_orchestrator.ownerPaths =
      changed.modules.reviewer_orchestrator.ownerPaths.filter((value: string) => value !== path)
    expect(auditModuleOwnership(changed, files).missing).toContain(path)
  })

  it('gives exact ownership precedence over test membership in other modules', () => {
    expect(modulesForPath(manifest, 'src/main/reviewer/correction-owner.test.ts')).toEqual([
      'reviewer_orchestrator'
    ])
  })

  it('runs a changed registered test directly without expanding its source consumers', () => {
    const path = 'src/main/reviewer/correction-owner.test.ts'
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toEqual([path])
    expect(plan.modules).toEqual(['reviewer_orchestrator'])
  })

  it('keeps source consumers in mixed source and test changes', () => {
    const test = 'src/main/reviewer/correction-owner.test.ts'
    const path = 'src/main/connectors/descriptors/genes-ontology.ts'
    const sourcePlan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    const mixed = createAffectedTestPlan(
      [
        { path, status: 'modified' },
        { path: test, status: 'modified' }
      ],
      graph
    )
    expect(mixed.testFiles).toEqual([...new Set([...sourcePlan.testFiles, test])].sort())
  })

  it('keeps unknown test files on full fallback', () => {
    expect(
      createAffectedTestPlan([{ path: 'src/main/new.test.ts', status: 'added' }], graph).mode
    ).toBe('full')
  })

  it('executes explicitly owned shared contracts with an explained full plan', () => {
    const path = 'src/shared/reviewer.ts'
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('full')
    expect(plan.reasonChains.join('\n')).toContain('Shared cross-process contracts')
    expect(plan.reasonChains.join('\n')).not.toContain('unknown module owner')
    expect(createModuleTestPlan('shared_conversation_contracts').mode).toBe('full')
  })

  it('keeps locale data separate from the shared translation runtime', () => {
    const catalog = createAffectedTestPlan(
      [{ path: 'src/shared/i18n/locales/zh-Hans.json', status: 'modified' }],
      graph
    )
    expect(catalog.testFiles).toEqual([
      'src/main/locale/owner.test.ts',
      'src/renderer/src/i18n/resources.test.ts'
    ])
    const runtime = createAffectedTestPlan(
      [{ path: 'src/shared/i18n/core.ts', status: 'modified' }],
      graph
    )
    expect(runtime.modules).toContain('i18n_shared_runtime')
    expect(runtime.testFiles).toContain(
      'src/renderer/src/pages/settings/SkillsPanel.render.test.tsx'
    )
  })
})

it.each(['certification-contract', 'execution-contract'])(
  'expands consumers of the shared Delegation %s test contract',
  (name) => {
    const path = `src/main/delegation/${name}.test.ts`
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles).toContain(path)
    expect(plan.testFiles).toContain('src/main/delegation/acp-execution.test.ts')
  }
)

it.each([
  'shared_application_contracts',
  'shared_conversation_contracts',
  'shared_workspace_contracts'
])('retains intentional full validation for edited tests in %s', (moduleId) => {
  const module = manifest.modules[moduleId]
  const path = module.ownerPaths.find(
    (path: string) => /\.test\.tsx?$/.test(path) && !module.interfacePaths.includes(path)
  )
  expect(path).toBeDefined()
  const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
  expect(plan.mode).toBe('full')
  expect(plan.reasonChains.join('\n')).toContain(module.fullTestReason)
})

it.each([
  'packages/process-tree-native/src/process_tree_native.cc',
  'packages/process-tree-native/index.cjs',
  'packages/process-tree-native/index.d.ts'
])('retains dynamic native loading coverage for %s', (path) => {
  const test = 'src/main/process-tree-native-loading.macos.integration.test.ts'
  const edges = JSON.parse(
    readFileSync(resolve('scripts/ci/module-runtime-consumers.json'), 'utf8')
  )
  expect(edges['packages/process-tree-native/index.cjs']).toContain(test)
  const plan = createAffectedTestPlan([{ path, status: 'modified' }], graph)
  expect(plan.mode).toBe('selective')
  expect(plan.testFiles).toContain(test)
})
