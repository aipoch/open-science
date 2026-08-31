import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateModuleImpactManifest } from './validate-module-impact.mjs'

const readManifest = (): ReturnType<JSON['parse']> =>
  JSON.parse(readFileSync(resolve('scripts/ci/module-impact.json'), 'utf8'))

describe('module ownership and test impact manifest', () => {
  it('validates the repository manifest and every declared evidence path', () => {
    const manifest = readManifest()

    expect(
      validateModuleImpactManifest(manifest, {
        pathExists: (repoPath: string) => existsSync(resolve(repoPath))
      })
    ).toBe(manifest)
  })

  it('rejects ambiguous module owners', () => {
    const manifest = readManifest()
    manifest.modules.workspace_runtime.ownerPaths = ['src/renderer/src/stores/session-store.ts']

    expect(() => validateModuleImpactManifest(manifest)).toThrow(
      'Module owner path src/renderer/src/stores/session-store.ts is shared by session_renderer and workspace_runtime'
    )
  })

  it('rejects test evidence classified under more than one seam', () => {
    const manifest = readManifest()
    const duplicate = manifest.modules.workspace_runtime.testFiles.owner[0]
    manifest.modules.workspace_runtime.testFiles.contract.push(duplicate)

    expect(() => validateModuleImpactManifest(manifest)).toThrow(
      `workspace_runtime.testFiles classifies ${duplicate} more than once`
    )
  })

  it('rejects unknown and cyclic module consumers', () => {
    const unknownManifest = readManifest()
    unknownManifest.modules.workspace_page.consumerModules = ['unknown_module']
    expect(() => validateModuleImpactManifest(unknownManifest)).toThrow(
      'Unknown consumer module for workspace_page: unknown_module'
    )

    const cyclicManifest = readManifest()
    cyclicManifest.modules.workspace_page.consumerModules = ['session_renderer']
    expect(() => validateModuleImpactManifest(cyclicManifest)).toThrow(
      'Module-impact consumer cycle: session_renderer -> workspace_runtime -> workspace_page -> session_renderer'
    )
  })

  it.each([
    'src\\renderer\\session-store.test.ts',
    'C:/repo/session-store.test.ts',
    '/repo/session-store.test.ts',
    '../session-store.test.ts'
  ])('rejects non-portable evidence path %s', (testFile) => {
    const manifest = readManifest()
    manifest.modules.session_renderer.testFiles.owner = [testFile]

    expect(() => validateModuleImpactManifest(manifest)).toThrow(
      'session_renderer.testFiles must be a portable repository-relative path'
    )
  })

  it('rejects missing module evidence paths', () => {
    const manifest = readManifest()

    expect(() =>
      validateModuleImpactManifest(manifest, {
        pathExists: (repoPath: string) => repoPath !== 'src/main/artifacts/repository.test.ts'
      })
    ).toThrow('artifact_storage.testFiles does not exist: src/main/artifacts/repository.test.ts')
  })

  it('rejects unknown module capability references', () => {
    const overlayManifest = readManifest()
    overlayManifest.modules.artifact_storage.capabilityOverlays = ['unknown_overlay']
    expect(() => validateModuleImpactManifest(overlayManifest)).toThrow(
      'Unknown capability overlay for artifact_storage: unknown_overlay'
    )

    const fallbackManifest = readManifest()
    fallbackManifest.modules.workspace_page.fallbackCapability = 'unknown_fallback'
    expect(() => validateModuleImpactManifest(fallbackManifest)).toThrow(
      'Unknown fallback capability for workspace_page: unknown_fallback'
    )
  })
})
