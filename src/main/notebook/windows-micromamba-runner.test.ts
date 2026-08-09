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
