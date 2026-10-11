import { rmSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveRuntimeCdnBase } from '../../../src/main/notebook/environment-resources'

const tmpRoots: string[] = []

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    // best-effort cleanup; ignore failures
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
})

describe('runtime CDN platform mapping', () => {
  it('trims CDN base overrides without changing the path namespace', () => {
    expect(resolveRuntimeCdnBase('https://cdn.example/open-science///')).toBe(
      'https://cdn.example/open-science'
    )
  })
})

it('maps product overrides and an explicit runtime root to the package inputs', async () => {
  const { notebookMicromambaOptions } = await import('./environment-resources')
  expect(
    notebookMicromambaOptions({
      env: { HOME: '/unrelated-home', OPEN_SCIENCE_MICROMAMBA_BIN: '/configured/micromamba' },
      runtimeRoot: '/research/runtime',
      resourcesPath: '/application/resources'
    })
  ).toMatchObject({
    override: '/configured/micromamba',
    runtimeRoot: '/research/runtime',
    resourcesPath: '/application/resources'
  })
})
