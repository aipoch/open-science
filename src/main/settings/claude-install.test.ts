import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallLogEvent } from '../../shared/settings'
import { detectNpmAvailable, getInstallSpawnSpec, runInstall } from './claude-install'

// Minimal fake child process exposing the stdout/stderr/exit surface runInstall consumes.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

describe('claude-install: command construction', () => {
  it('runs npm against the China mirror registry', () => {
    const spec = getInstallSpawnSpec('npm-mirror')

    expect(spec.command).toBe('npm')
    expect(spec.args).toEqual([
      'i',
      '-g',
      '@anthropic-ai/claude-code',
      '--registry=https://registry.npmmirror.com'
    ])
  })

  it('pipes the official installer through a shell', () => {
    const spec = getInstallSpawnSpec('official-script')

    expect(spec.command).toBe('bash')
    expect(spec.args.at(-1)).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  })
})

describe('claude-install: run', () => {
  it('streams stdout/stderr and resolves ok on exit code 0', async () => {
    const child = new FakeChild()
    const logs: ClaudeInstallLogEvent[] = []
    const promise = runInstall({
      source: 'npm-mirror',
      installId: 'install-1',
      onLog: (event) => logs.push(event),
      spawnImpl: () => child as never
    })

    child.stdout.emit('data', Buffer.from('adding package\n'))
    child.stderr.emit('data', Buffer.from('warn\n'))
    child.emit('exit', 0)

    const result = await promise

    expect(result).toMatchObject({ installId: 'install-1', ok: true, exitCode: 0 })
    expect(
      logs.some((log) => log.stream === 'stdout' && log.chunk.includes('adding package'))
    ).toBe(true)
    expect(logs.some((log) => log.stream === 'stderr')).toBe(true)
  })

  it('resolves not ok on a non-zero exit', async () => {
    const child = new FakeChild()
    const promise = runInstall({
      source: 'npm-mirror',
      installId: 'install-2',
      onLog: () => undefined,
      spawnImpl: () => child as never
    })

    child.emit('exit', 1)

    await expect(promise).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })

  it('reports a spawn failure without throwing', async () => {
    const result = await runInstall({
      source: 'npm-mirror',
      installId: 'install-3',
      onLog: () => undefined,
      spawnImpl: () => {
        throw new Error('spawn npm ENOENT')
      }
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('ENOENT')
  })
})

describe('claude-install: npm availability', () => {
  it('reports available when the npm probe resolves', async () => {
    await expect(detectNpmAvailable(() => Promise.resolve())).resolves.toEqual({ available: true })
  })

  it('reports unavailable when the npm probe rejects', async () => {
    await expect(detectNpmAvailable(() => Promise.reject(new Error('not found')))).resolves.toEqual(
      { available: false }
    )
  })
})
