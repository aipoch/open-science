import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  looksLikeOpenScienceRuntime,
  terminateVerifiedLegacyRuntime,
  type LegacyTerminationDeps
} from './legacy-service-termination'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const RUNTIME =
  '/Applications/Open-Science.app/Contents/Resources/node-runtime/node /Applications/Open-Science.app/Contents/Resources/backend/out/backend/index.cjs --desktop --serve'

function setup(overrides: Partial<LegacyTerminationDeps> = {}): {
  options: { configRoot: string; generation: string; pid: number }
  deps: Partial<LegacyTerminationDeps>
  signal: ReturnType<typeof vi.fn>
} {
  const configRoot = mkdtempSync(join(tmpdir(), 'legacy-term-'))
  roots.push(configRoot)
  let alive = true
  const signal = vi.fn(async (_pid: number, mode: 'terminate' | 'kill') => {
    if (mode === 'kill') alive = false
  })
  return {
    options: { configRoot, generation: 'g', pid: 424242 },
    signal,
    deps: {
      inspect: async () => ({ commandLine: RUNTIME, parentPid: 1 }),
      isAlive: () => alive,
      signal,
      selfPid: 99,
      lockHeld: () => alive,
      graceMs: 150,
      settleMs: 150,
      ...overrides
    }
  }
}

describe('verified legacy runtime termination', () => {
  it('recognizes only Open-Science runtime entries', () => {
    expect(looksLikeOpenScienceRuntime(RUNTIME)).toBe(true)
    expect(
      looksLikeOpenScienceRuntime(
        'C:\\Program Files\\Open-Science\\resources\\backend\\out\\backend\\index.cjs --serve'
      )
    ).toBe(true)
    expect(looksLikeOpenScienceRuntime('/usr/bin/node /home/u/app/server.js')).toBe(false)
    expect(looksLikeOpenScienceRuntime('vim backend/index.cjs.bak')).toBe(false)
  })
  it('terminates a proven runtime and then kills it when it ignores the request', async () => {
    const { options, deps, signal } = setup()
    await terminateVerifiedLegacyRuntime(options, deps)
    expect(signal.mock.calls.map(([, mode]) => mode)).toEqual(['terminate', 'kill'])
  })
  it('stops after a graceful terminate when the process exits', async () => {
    let alive = true
    const { options, deps, signal } = setup({ isAlive: () => alive, lockHeld: () => alive })
    signal.mockImplementation(async (_pid, mode) => {
      if (mode === 'terminate') alive = false
    })
    await terminateVerifiedLegacyRuntime(options, deps)
    expect(signal.mock.calls.map(([, mode]) => mode)).toEqual(['terminate'])
  })
  it.each<[string, Partial<LegacyTerminationDeps>]>([
    ['another program', { inspect: async () => ({ commandLine: '/usr/bin/node other.js' }) }],
    ['unreadable process', { inspect: async () => undefined }],
    ['no runtime lock held', { lockHeld: () => false, isAlive: () => true }],
    ['this Desktop', { selfPid: 424242 }],
    [
      'a child of this Desktop',
      { selfPid: 7, inspect: async () => ({ commandLine: RUNTIME, parentPid: 7 }) }
    ]
  ])('never signals %s', async (_name, override) => {
    const { options, deps, signal } = setup(override)
    await expect(terminateVerifiedLegacyRuntime(options, deps)).rejects.toMatchObject({
      code: 'identity-unproven'
    })
    expect(signal).not.toHaveBeenCalled()
  })
  it('continues when the process is already gone and the lock is free', async () => {
    const { options, deps, signal } = setup({ isAlive: () => false, lockHeld: () => false })
    await expect(terminateVerifiedLegacyRuntime(options, deps)).resolves.toBeUndefined()
    expect(signal).not.toHaveBeenCalled()
  })
  it('reports a failed stop when the process survives a kill', async () => {
    const { options, deps } = setup({ isAlive: () => true, lockHeld: () => true })
    await expect(terminateVerifiedLegacyRuntime(options, deps)).rejects.toMatchObject({
      code: 'not-stopped'
    })
  })
})
