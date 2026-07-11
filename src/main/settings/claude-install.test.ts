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
  it('runs a plain global npm install without a mirror registry', () => {
    const spec = getInstallSpawnSpec('npm', 'linux')

    expect(spec.command).toBe('npm')
    expect(spec.args).toEqual(['i', '-g', '@anthropic-ai/claude-code'])
    expect(spec.args.some((arg) => arg.includes('--registry'))).toBe(false)
    expect(spec.shell).toBeFalsy()
  })

  it('pipes the official installer through bash on Unix', () => {
    const spec = getInstallSpawnSpec('official-script', 'linux')

    expect(spec.command).toBe('bash')
    expect(spec.args.at(-1)).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('runs npm through a shell on Windows (npm.cmd shim)', () => {
    const spec = getInstallSpawnSpec('npm', 'win32')

    expect(spec.command).toBe('npm')
    expect(spec.args).toEqual(['i', '-g', '@anthropic-ai/claude-code'])
    expect(spec.shell).toBe(true)
  })

  it('uses the PowerShell installer (install.ps1) on Windows', () => {
    const spec = getInstallSpawnSpec('official-script', 'win32')

    expect(spec.command).toBe('powershell')
    expect(spec.args.at(-1)).toContain('irm https://claude.ai/install.ps1 | iex')
  })
})

describe('claude-install: run', () => {
  it('streams stdout/stderr and resolves ok on exit code 0', async () => {
    const child = new FakeChild()
    const logs: ClaudeInstallLogEvent[] = []
    const promise = runInstall({
      source: 'npm',
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
      source: 'npm',
      installId: 'install-2',
      onLog: () => undefined,
      spawnImpl: () => child as never
    })

    child.emit('exit', 1)

    await expect(promise).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })

  it('reports a spawn failure without throwing', async () => {
    const result = await runInstall({
      source: 'npm',
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
