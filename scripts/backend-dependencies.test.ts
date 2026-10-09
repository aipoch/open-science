import { describe, expect, it } from 'vitest'
import { assertBackendImports, isElectronPackage } from './backend-dependencies.mjs'

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
})
