import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  PACKAGE_SMOKE_PLATFORMS,
  resolvePackageSmokeMatrix
} from './resolve-package-smoke-matrix.mjs'

const scriptPath = fileURLToPath(new URL('./resolve-package-smoke-matrix.mjs', import.meta.url))

describe('package-smoke matrix resolution', () => {
  it('emits a single-line GitHub Actions matrix for the unfiltered Nightly path', () => {
    const encoded = resolvePackageSmokeMatrix('')
    expect(encoded).not.toMatch(/\n|\r/)
    expect(JSON.parse(encoded)).toEqual({ include: PACKAGE_SMOKE_PLATFORMS })
  })

  it('treats all as the full matrix and filters a named platform', () => {
    expect(JSON.parse(resolvePackageSmokeMatrix('all'))).toEqual({
      include: PACKAGE_SMOKE_PLATFORMS
    })
    expect(JSON.parse(resolvePackageSmokeMatrix('macos-x64'))).toEqual({
      include: [PACKAGE_SMOKE_PLATFORMS[1]]
    })
  })

  it('fails closed on an unknown platform name', () => {
    expect(() => resolvePackageSmokeMatrix('macos-intel')).toThrow(
      "unknown platform_name 'macos-intel'"
    )
  })

  it('prints compact JSON on stdout for GITHUB_OUTPUT', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, PLATFORM_NAME: '' }
    })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toMatch(/\n|\r/)
    expect(JSON.parse(result.stdout)).toEqual({ include: PACKAGE_SMOKE_PLATFORMS })
  })
})
