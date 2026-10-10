import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertBackendImports,
  backendDependencyIncludes,
  isElectronPackage,
  isShippableDependencyPath
} from './backend-dependencies.mjs'

describe('standalone dependency boundary', () => {
  it.each([
    'electron',
    'electron/main',
    'electron-updater',
    '@electron-toolkit/utils',
    '@electron/remote'
  ])('forbids %s in the package closure', (name) => {
    expect(isElectronPackage(name)).toBe(true)
  })
  it('rejects an Electron import in any reachable worker or transitive source', () => {
    expect(() =>
      assertBackendImports(
        [{ inputs: { 'deep/worker.ts': { imports: [{ path: 'electron' }] } }, outputs: {} }],
        {}
      )
    ).toThrow('deep/worker.ts')
  })
  it('rejects a development-only runtime dependency before producing an incomplete package', () => {
    expect(() =>
      assertBackendImports(
        [
          { inputs: {}, outputs: { 'index.cjs': { imports: [{ path: 'saxes', external: true }] } } }
        ],
        {}
      )
    ).toThrow('production: saxes')
    expect(() =>
      assertBackendImports(
        [
          {
            inputs: {},
            outputs: {
              'index.cjs': {
                imports: [
                  { path: 'saxes', external: true },
                  { path: 'node:sqlite', external: true }
                ]
              }
            }
          }
        ],
        { saxes: '6.0.0' }
      )
    ).not.toThrow()
  })
  describe('isShippableDependencyPath', () => {
    it.each([
      'package.json',
      'build/Release/probe.node',
      join('build', 'Release', 'probe.node'),
      'src/index.js'
    ])('ships %s', (path) => {
      expect(isShippableDependencyPath(path)).toBe(true)
    })
    it.each([
      'node_modules',
      join('node_modules', 'left-pad', 'index.js'),
      '.git',
      join('.git', 'HEAD'),
      'build/Release/obj.target',
      join('build', 'Release', 'obj.target', 'probe', 'src', 'probe.o'),
      join('build', 'Release', 'obj.target')
    ])('excludes %s', (path) => {
      expect(isShippableDependencyPath(path)).toBe(false)
    })
  })
})

const pdfManifest = JSON.parse(readFileSync('packages/pdf-structure/package.json', 'utf8'))
it.each(['/', '\\'])('stages the PDF npm runtime without source fixtures (%s)', (separator) => {
  for (const path of [
    'dist/index.js',
    'dist/result.d.ts',
    'resources/host.mjs',
    'package.json',
    'LICENSE',
    'README.md'
  ])
    expect(backendDependencyIncludes(pdfManifest, path.split('/').join(separator))).toBe(true)
  for (const path of [
    'src/engine.ts',
    'test/fixtures/case.jsonl',
    'node_modules/sharp/index.js',
    '.git/config',
    'tsconfig.json'
  ])
    expect(backendDependencyIncludes(pdfManifest, path.split('/').join(separator))).toBe(false)
  expect(backendDependencyIncludes(pdfManifest, '')).toBe(true)
})
