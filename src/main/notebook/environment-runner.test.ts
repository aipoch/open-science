import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createMicromambaRunnerResolver, type MicromambaRunnerCandidate } from '@aipoch/environment'
import { createProductionMicromambaRunner } from './environment-runner'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const fixture = (
  root: string,
  id: string,
  contents: string,
  expectedSha256 = sha256(contents)
): MicromambaRunnerCandidate => {
  const path = join(root, 'resources', id, 'micromamba.exe')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return { id, path, expectedSha256 }
}

const contentsOf = (path: string): string => readFileSync(path, 'utf8')

describe('createProductionMicromambaRunner', () => {
  it('returns undefined when Windows has neither a runner candidate nor a tools root', () => {
    expect(
      createProductionMicromambaRunner({
        platform: 'win32',
        env: {},
        resourcesPath: join(mkdtempSync(join(tmpdir(), 'os-mm-missing-')), 'missing')
      })
    ).toBeUndefined()
  })

  it('discovers a hash-pinned current-version tools-cache runner in a dev build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-production-'))
    const toolsDir = join(root, 'tools')
    const fallbackDir = join(root, 'fallback')
    const fallbackContents = 'old-path-runner'
    const primaryContents = 'current-primary'
    const primaryDigest = sha256(primaryContents)
    const primaryId = 'primary-test-release'
    const cachedPrimary = join(toolsDir, primaryId, primaryDigest, 'micromamba.exe')
    const fallback = join(fallbackDir, 'micromamba.exe')
    mkdirSync(dirname(cachedPrimary), { recursive: true })
    mkdirSync(dirname(fallback), { recursive: true })
    writeFileSync(cachedPrimary, primaryContents)
    writeFileSync(fallback, fallbackContents)
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(
      join(toolsDir, 'selection.json'),
      JSON.stringify({ schema: 1, candidateId: 'path-1', sha256: sha256(fallbackContents) })
    )

    vi.resetModules()
    vi.doMock('../../../scripts/micromamba-versions.json', () => ({
      default: {
        releaseTag: 'test-release',
        binarySha256: { 'win-64': primaryDigest },
        compatibility: {
          releaseTag: 'test-compat',
          binarySha256: { 'win-64': sha256('compat') }
        }
      }
    }))
    try {
      const { createProductionMicromambaRunner } = await import('./environment-runner')
      const runner = createProductionMicromambaRunner({
        platform: 'win32',
        env: { PATH: fallbackDir },
        resourcesPath: join(root, 'missing-resources'),
        home: root,
        localToolsDir: toolsDir,
        preflight: async () => undefined
      })

      expect(runner).toBeDefined()
      expect(contentsOf(await runner!.resolve())).toBe(primaryContents)
    } finally {
      vi.doUnmock('../../../scripts/micromamba-versions.json')
      vi.resetModules()
    }
  })

  it('rejects a tampered current-version tools-cache runner and keeps the PATH fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-production-'))
    const toolsDir = join(root, 'tools')
    const fallbackDir = join(root, 'fallback')
    const fallbackContents = 'old-path-runner'
    const expectedPrimaryDigest = sha256('official-current-primary')
    const primaryId = 'primary-test-release'
    const cachedPrimary = join(toolsDir, primaryId, expectedPrimaryDigest, 'micromamba.exe')
    const fallback = join(fallbackDir, 'micromamba.exe')
    mkdirSync(dirname(cachedPrimary), { recursive: true })
    mkdirSync(dirname(fallback), { recursive: true })
    writeFileSync(cachedPrimary, 'tampered-primary')
    writeFileSync(fallback, fallbackContents)
    mkdirSync(toolsDir, { recursive: true })
    writeFileSync(
      join(toolsDir, 'selection.json'),
      JSON.stringify({ schema: 1, candidateId: 'path-1', sha256: sha256(fallbackContents) })
    )

    vi.resetModules()
    vi.doMock('../../../scripts/micromamba-versions.json', () => ({
      default: {
        releaseTag: 'test-release',
        binarySha256: { 'win-64': expectedPrimaryDigest },
        compatibility: {
          releaseTag: 'test-compat',
          binarySha256: { 'win-64': sha256('compat') }
        }
      }
    }))
    try {
      const productionModule = await import('./environment-runner')
      const runner = productionModule.createProductionMicromambaRunner({
        platform: 'win32',
        env: { PATH: fallbackDir },
        resourcesPath: join(root, 'missing-resources'),
        home: root,
        localToolsDir: toolsDir,
        preflight: async () => undefined
      })

      expect(runner).toBeDefined()
      expect(contentsOf(await runner!.resolve())).toBe(fallbackContents)
    } finally {
      vi.doUnmock('../../../scripts/micromamba-versions.json')
      vi.resetModules()
    }
  })
})

it.each([
  { packaged: false, suffix: 'override' },
  { packaged: true, suffix: 'local/Open-Science' }
])(
  'uses the same brand config rules for actual tool writes ($packaged)',
  async ({ packaged, suffix }) => {
    const root = mkdtempSync(join(tmpdir(), 'brand-tools-call-'))
    try {
      const binary = fixture(root, 'explicit', 'isolated-executable')
      const runner = createProductionMicromambaRunner({
        packaged,
        platform: 'win32',
        home: root,
        resourcesPath: join(root, 'absent'),
        env: {
          LOCALAPPDATA: join(root, 'local'),
          OPEN_SCIENCE_STORAGE_ROOT: `  ${root}/ignored/../override  `,
          OPEN_SCIENCE_MICROMAMBA_BIN: binary.path
        },
        preflight: async () => undefined
      })
      const selected = await runner!.resolve()
      expect(selected.startsWith(join(root, suffix, 'tools', 'micromamba') + sep)).toBe(true)
      expect(contentsOf(selected)).toBe('isolated-executable')
      expect(
        JSON.parse(contentsOf(join(root, suffix, 'tools', 'micromamba', 'selection.json'))).schema
      ).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it('keeps the development config home separate from a custom research disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-tools-home-'))
  try {
    const binary = fixture(root, 'explicit', 'isolated-executable')
    const runner = createProductionMicromambaRunner({
      packaged: false,
      platform: 'win32',
      home: join(root, 'research-disk'),
      configHome: join(root, 'user-home'),
      resourcesPath: join(root, 'absent'),
      env: { LOCALAPPDATA: join(root, 'local'), OPEN_SCIENCE_MICROMAMBA_BIN: binary.path },
      preflight: async () => undefined
    })
    expect(
      (await runner!.resolve()).startsWith(
        join(root, 'user-home', '.open-science-project', 'tools', 'micromamba') + sep
      )
    ).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('retains a validated legacy tool selection receipt when no configuration override is supplied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'brand-tools-receipt-'))
  try {
    const binary = fixture(root, 'override', 'isolated-executable')
    const toolsDir = join(root, 'local', 'OpenScience', 'tools', 'micromamba')
    const first = await createMicromambaRunnerResolver({
      candidates: [binary],
      toolsDir,
      preflight: async () => undefined
    }).resolve()
    const runner = createProductionMicromambaRunner({
      packaged: true,
      platform: 'win32',
      home: root,
      resourcesPath: join(root, 'absent'),
      env: { LOCALAPPDATA: join(root, 'local'), OPEN_SCIENCE_MICROMAMBA_BIN: binary.path },
      preflight: async () => undefined
    })
    expect(await runner!.resolve()).toBe(first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['OPEN_SCIENCE_E2E_STORAGE_ROOT', 'OPEN_SCIENCE_CONFIG_ROOT', 'OPEN_SCIENCE_STORAGE_ROOT'])(
  'rejects a relative %s before creating tool state',
  (key) => {
    expect(() =>
      createProductionMicromambaRunner({
        packaged: false,
        platform: 'win32',
        env: { [key]: '  relative-path  ' }
      })
    ).toThrow(`${key} must be an absolute path.`)
  }
)

vi.mock('../runtime-metadata', () => ({
  runtimeMetadata: () => ({ packaged: false, resourcesPath: '', homePath: '' }),
  runtimeMetadataIfConfigured: () => ({ packaged: false, resourcesPath: '', homePath: '' })
}))

it('delegates signed candidate trust and rejects it without an injected verifier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-trust-'))
  try {
    const resourcesPath = join(root, 'resources')
    mkdirSync(resourcesPath)
    writeFileSync(join(resourcesPath, 'micromamba.exe'), 'signed-by-the-release-build')
    const options = {
      platform: 'win32' as const,
      env: {},
      resourcesPath,
      localToolsDir: join(root, 'tools'),
      preflight: async () => undefined
    }
    await expect(createProductionMicromambaRunner(options)!.resolve()).rejects.toThrow(
      /Authenticode/
    )
    const verifySignature = vi.fn(async () => undefined)
    const path = await createProductionMicromambaRunner({ ...options, verifySignature })!.resolve()
    expect(contentsOf(path)).toBe('signed-by-the-release-build')
    expect(verifySignature).toHaveBeenCalledWith(join(resourcesPath, 'micromamba.exe'))
    expect(verifySignature.mock.calls.length).toBeGreaterThan(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
