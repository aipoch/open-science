import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

it.each(['darwin', 'linux', 'win32'] as const)(
  'resolves the backend micromamba without an Electron root copy (%s)',
  async (platform) => {
    const { resolveNotebookMicromamba } = await import('./environment-resources')
    const root = mkdtempSync(join(tmpdir(), 'backend-micromamba-'))
    tmpRoots.push(root)
    const resourcesPath = join(root, 'backend', 'resources')
    mkdirSync(resourcesPath, { recursive: true })
    const name = platform === 'win32' ? 'micromamba.exe' : 'micromamba'
    const binary = join(resourcesPath, name)
    writeFileSync(binary, 'backend runner')
    const deps = { env: {}, platform, resourcesPath }
    expect(resolveNotebookMicromamba(deps)).toBe(binary)
    writeFileSync(join(root, name), 'unused Electron copy')
    expect(resolveNotebookMicromamba(deps)).toBe(binary)
    rmSync(binary)
    expect(resolveNotebookMicromamba(deps)).toBeUndefined()
  }
)
