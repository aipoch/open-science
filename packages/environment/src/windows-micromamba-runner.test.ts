import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createMicromambaRunnerResolver,
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

  it('accepts signed bundled bytes after verifying Authenticode instead of comparing the raw digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const signed = {
      ...fixture(root, 'primary', 'signed-primary', sha256('official-primary')),
      verifySignature: true
    }
    const verifySignature = vi.fn(async () => undefined)

    const selected = await createMicromambaRunnerResolver({
      candidates: [signed],
      toolsDir: join(root, 'local-tools'),
      verifySignature,
      preflight: async () => undefined
    }).resolve()

    expect(contentsOf(selected)).toBe('signed-primary')
    expect(verifySignature).toHaveBeenCalledTimes(2)
    expect(selected).toContain(sha256('signed-primary'))
  })

  it('rejects changed bundled bytes when Authenticode verification fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const signed = {
      ...fixture(root, 'primary', 'changed-primary', sha256('official-primary')),
      verifySignature: true
    }
    const compatibility = fixture(root, 'compat', 'compat')
    const verifySignature = vi.fn(async () => {
      throw new Error('invalid Authenticode status: NotSigned')
    })
    const attempted: string[] = []

    const selected = await createMicromambaRunnerResolver({
      candidates: [signed, compatibility],
      toolsDir: join(root, 'local-tools'),
      verifySignature,
      preflight: async (path) => {
        attempted.push(contentsOf(path))
      }
    }).resolve()

    expect(contentsOf(selected)).toBe('compat')
    expect(verifySignature).toHaveBeenCalledOnce()
    expect(attempted).toEqual(['compat'])
  })

  it('revalidates the signature when reusing a cached signed selection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-mm-runner-'))
    const signed = {
      ...fixture(root, 'primary', 'signed-primary', sha256('official-primary')),
      verifySignature: true
    }
    const verifySignature = vi.fn(async () => undefined)
    const toolsDir = join(root, 'local-tools')

    await createMicromambaRunnerResolver({
      candidates: [signed],
      toolsDir,
      verifySignature,
      preflight: async () => undefined
    }).resolve()
    verifySignature.mockClear()
    const preflight = vi.fn(async () => undefined)

    const selected = await createMicromambaRunnerResolver({
      candidates: [signed],
      toolsDir,
      verifySignature,
      preflight
    }).resolve()

    expect(contentsOf(selected)).toBe('signed-primary')
    expect(preflight).toHaveBeenCalledOnce()
    expect(verifySignature).toHaveBeenCalledOnce()
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
