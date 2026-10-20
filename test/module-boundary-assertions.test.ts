import { describe, expect, it } from 'vitest'
import type { ModuleImpactManifest } from '../scripts/ci/load-module-impact.mjs'
import {
  expectBoundaryOwnerTests,
  expectModuleBoundary,
  expectTypeOnlyContract,
  runtimeModuleSpecifiers
} from './module-boundary-assertions'

const boundary = {
  ownerPaths: ['src/main/facade.ts', 'src/main/model.ts', 'src/main/model.test.ts'],
  interfacePaths: ['src/main/facade.ts', 'src/main/model.ts'],
  testFiles: {
    owner: ['src/main/model.test.ts'],
    contract: ['src/main/contract.test.ts'],
    consumer: ['src/renderer/view.test.ts']
  },
  consumerModules: ['view'],
  capabilityOverlays: ['windows_sensitive'],
  fallbackCapability: 'main_runtime'
}
function split(): ModuleImpactManifest {
  const original = structuredClone(boundary)
  original.ownerPaths = ['src/main/facade.ts']
  original.testFiles.owner = []
  const model = structuredClone(boundary)
  model.ownerPaths = ['src/main/model.ts', 'src/main/model.test.ts']
  return { schemaVersion: 1, modules: { original, model } }
}

describe('module boundary assertions', () => {
  it('retains policy when checking moved owner tests independently of source paths', () => {
    const manifest = split()
    manifest.modules.original.fullTestReason = 'shared contracts'
    manifest.modules.model.fullTestReason = 'shared contracts'
    const check = (): void =>
      expectBoundaryOwnerTests(manifest, 'original', boundary.testFiles.owner)
    check()
    delete manifest.modules.model.fullTestReason
    expect(check).toThrow()
  })
  it('retains domain invariants across unique owner and owner-test transfers', () => {
    expectModuleBoundary(split(), 'original', boundary)
    expectModuleBoundary(
      { schemaVersion: 1, modules: { original: structuredClone(boundary) } },
      'original',
      boundary
    )
  })
  it.each([
    'missing-owner',
    'duplicate-owner',
    'test-classification',
    'interface',
    'contract',
    'consumer',
    'routing',
    'overlay',
    'fallback',
    'full-marker'
  ] as const)('rejects a lost %s obligation', (failure) => {
    const manifest = split()
    const expected = structuredClone(boundary)
    if (failure === 'missing-owner') manifest.modules.model.ownerPaths = []
    if (failure === 'duplicate-owner')
      manifest.modules.original.ownerPaths.push('src/main/model.ts')
    if (failure === 'test-classification') manifest.modules.model.testFiles.owner = []
    if (failure === 'interface') manifest.modules.model.interfacePaths = []
    if (failure === 'contract') manifest.modules.model.testFiles.contract = []
    if (failure === 'consumer') manifest.modules.original.testFiles.consumer = []
    if (failure === 'routing') manifest.modules.model.consumerModules = []
    if (failure === 'overlay') manifest.modules.model.capabilityOverlays = []
    if (failure === 'fallback') manifest.modules.model.fallbackCapability = 'renderer_view'
    if (failure === 'full-marker') {
      Object.assign(expected, { fullTestReason: 'shared contracts' })
      manifest.modules.original.fullTestReason = 'shared contracts'
    }
    expect(() => expectModuleBoundary(manifest, 'original', expected)).toThrow()
  })
  it('distinguishes erased types from side effects, mixed imports, reexports and loaders', () => {
    expect(
      runtimeModuleSpecifiers(`import type { A } from './a'; import { type B } from './b';
      export type { C } from './c'; export { type D } from './d';
      import './effect'; import E, { type F } from './mixed';
      export { type G, value } from './values'; export * from './star';
      void import('./lazy'); require('./required'); type H = import('./type').H;`)
    ).toEqual(['./effect', './mixed', './values', './star', './lazy', './required'])
  })
  it('retains empty named imports and exports that can load a module for side effects', () => {
    expect(
      runtimeModuleSpecifiers("import {} from './import-effect'; export {} from './export-effect'")
    ).toEqual(['./import-effect', './export-effect'])
  })
  it('allows public type contracts but rejects runtime state and side effects', () => {
    expectTypeOnlyContract(
      'contract.ts',
      `import type { A } from './a'
export interface B { a: A }
export type C = B`
    )
    for (const source of [
      "import './effect'",
      'export const state = {}',
      'export class Owner {}',
      'export enum Status { Ready }',
      "export * from './implementation'"
    ]) {
      expect(() => expectTypeOnlyContract('contract.ts', source)).toThrow()
    }
  })
})
