import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createMicromambaRunnerResolver,
  createProductionMicromambaRunner,
  type MicromambaRunnerCandidate
} from './windows-micromamba-runner'

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

describe('createMicromambaRunnerResolver', () => {
  it('falls back to the compatibility runner when the primary preflight access-violates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const candidates = [fixture(root, 'primary', 'primary'), fixture(root, 'compat', 'compat')]
    const preflight = vi.fn(async (path: string) => {
      if (contentsOf(path) === 'primary') {
        throw Object.assign(new Error('micromamba exited with 0xC0000005'), { code: -1073741819 })
      }
    })

    const runner = createMicromambaRunnerResolver({
      candidates,
      toolsDir: join(root, 'local-tools'),
      preflight
    })

    const selected = await runner.resolve()

    expect(contentsOf(selected)).toBe('compat')
    expect(preflight).toHaveBeenCalledTimes(2)
  })

  it('does not execute a primary runner whose pinned digest does not match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const primary = fixture(root, 'primary', 'tampered', sha256('official-primary'))
    const compatibility = fixture(root, 'compat', 'compat')
    const attempted: string[] = []

    const runner = createMicromambaRunnerResolver({
      candidates: [primary, compatibility],
      toolsDir: join(root, 'local-tools'),
      preflight: async (path) => {
        attempted.push(contentsOf(path))
      }
    })

    expect(contentsOf(await runner.resolve())).toBe('compat')
    expect(attempted).toEqual(['compat'])
  })

  it('reuses a validated cached compatibility selection before retrying the primary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const candidates = [fixture(root, 'primary', 'primary'), fixture(root, 'compat', 'compat')]
    const toolsDir = join(root, 'local-tools')
    const first = createMicromambaRunnerResolver({
      candidates,
      toolsDir,
      preflight: async (path) => {
        if (contentsOf(path) === 'primary') throw new Error('primary crashed')
      }
    })
    expect(contentsOf(await first.resolve())).toBe('compat')

    const attempted: string[] = []
    const nextStart = createMicromambaRunnerResolver({
      candidates,
      toolsDir,
      preflight: async (path) => {
        attempted.push(contentsOf(path))
      }
    })

    expect(contentsOf(await nextStart.resolve())).toBe('compat')
    expect(attempted).toEqual(['compat'])
  })

  it('does not let a cached PATH receipt override a newly available pinned primary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const toolsDir = join(root, 'local-tools')
    const fallback = fixture(root, 'path-1', 'old-path-runner')
    await createMicromambaRunnerResolver({
      candidates: [fallback],
      toolsDir,
      preflight: async () => undefined
    }).resolve()
    const pinned = {
      ...fixture(root, 'primary-current', 'current-primary'),
      selectionTier: 'pinned-primary' as const
    }

    const selected = await createMicromambaRunnerResolver({
      candidates: [pinned, fallback],
      toolsDir,
      preflight: async () => undefined
    }).resolve()

    expect(contentsOf(selected)).toBe('current-primary')
  })

  it('always honors an explicit override ahead of a cached compatibility receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const toolsDir = join(root, 'local-tools')
    const compatibility = {
      ...fixture(root, 'compat-current', 'compat'),
      selectionTier: 'compatibility' as const
    }
    await createMicromambaRunnerResolver({
      candidates: [compatibility],
      toolsDir,
      preflight: async () => undefined
    }).resolve()
    const override = {
      ...fixture(root, 'override', 'explicit-runner'),
      selectionTier: 'explicit' as const
    }

    const selected = await createMicromambaRunnerResolver({
      candidates: [override, compatibility],
      toolsDir,
      preflight: async () => undefined
    }).resolve()

    expect(contentsOf(selected)).toBe('explicit-runner')
  })

  it('keeps a validated compatibility receipt ahead of the previously failing pinned primary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const toolsDir = join(root, 'local-tools')
    const compatibility = {
      ...fixture(root, 'compat-current', 'compat'),
      selectionTier: 'compatibility' as const
    }
    await createMicromambaRunnerResolver({
      candidates: [compatibility],
      toolsDir,
      preflight: async () => undefined
    }).resolve()
    const pinned = {
      ...fixture(root, 'primary-current', 'primary'),
      selectionTier: 'pinned-primary' as const
    }
    const attempted: string[] = []

    const selected = await createMicromambaRunnerResolver({
      candidates: [pinned, compatibility],
      toolsDir,
      preflight: async (path) => {
        attempted.push(contentsOf(path))
      }
    }).resolve()

    expect(contentsOf(selected)).toBe('compat')
    expect(attempted).toEqual(['compat'])
  })

  it('keeps the normal primary path when its digest and preflight succeed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const candidates = [fixture(root, 'primary', 'primary'), fixture(root, 'compat', 'compat')]
    const preflight = vi.fn(async () => undefined)

    const selected = await createMicromambaRunnerResolver({
      candidates,
      toolsDir: join(root, 'local-tools'),
      preflight
    }).resolve()

    expect(contentsOf(selected)).toBe('primary')
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('tries each candidate once and reports every bounded failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const candidates = [fixture(root, 'primary', 'primary'), fixture(root, 'compat', 'compat')]
    const preflight = vi.fn(async (path: string) => {
      throw new Error(`${contentsOf(path)} crashed`)
    })
    const runner = createMicromambaRunnerResolver({
      candidates,
      toolsDir: join(root, 'local-tools'),
      preflight
    })

    await expect(runner.resolve()).rejects.toThrow(/primary.*crashed.*compat.*crashed/s)
    await expect(runner.resolve()).rejects.toThrow(/no usable micromamba runner/i)
    expect(preflight).toHaveBeenCalledTimes(2)
  })

  it('names the Windows access-violation status in the final diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const runner = createMicromambaRunnerResolver({
      candidates: [fixture(root, 'primary', 'primary')],
      toolsDir: join(root, 'local-tools'),
      preflight: async () => {
        throw Object.assign(new Error('runner crashed'), { code: -1073741819 })
      }
    })

    await expect(runner.resolve()).rejects.toThrow(/0xC0000005/)
  })
})

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
      const { createProductionMicromambaRunner } = await import('./windows-micromamba-runner')
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
      const productionModule = await import('./windows-micromamba-runner')
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
