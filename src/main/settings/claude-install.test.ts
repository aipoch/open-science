import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallLogEvent } from '../../shared/settings'
import {
  detectNpmAvailable,
  getInstallSpawnSpec,
  isRegionBlockedOutput,
  runInstall,
  runInstallWithFallback
} from './claude-install'

// Minimal fake child process exposing the stdout/stderr/exit surface runInstall consumes.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn()
}

// Per-command scripted spawn: emits the given stdout/stderr then exits on the next tick, so
// runInstall's listeners are attached before the events fire. Records the commands spawned.
type SpawnScript = { stdout?: string; stderr?: string; exit: number }
const scriptedSpawn = (
  scripts: Record<string, SpawnScript>
): { spawn: (command: string, args: string[]) => FakeChild; commands: string[] } => {
  const commands: string[] = []
  const spawn = (command: string): FakeChild => {
    commands.push(command)
    const child = new FakeChild()
    const script = scripts[command]

    setImmediate(() => {
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout))
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr))
      child.emit('exit', script.exit)
    })

    return child
  }

  return { spawn, commands }
}

describe('claude-install: command construction', () => {
  it('runs a global npm install into a user-writable prefix (no sudo) on Unix', () => {
    const spec = getInstallSpawnSpec('npm', 'linux', '/home/tester')

    expect(spec.command).toBe('npm')
    // --prefix ~/.local keeps the global install out of the system prefix, so no sudo is needed;
    // ~/.local/bin is already probed by detection and on the augmented PATH.
    expect(spec.args).toEqual([
      'i',
      '-g',
      '@anthropic-ai/claude-code',
      '--prefix',
      '/home/tester/.local'
    ])
    expect(spec.args.some((arg) => arg.includes('--registry'))).toBe(false)
    expect(spec.shell).toBeFalsy()
  })

  it('uses the same user prefix on macOS', () => {
    const spec = getInstallSpawnSpec('npm', 'darwin', '/Users/tester')

    expect(spec.args).toEqual([
      'i',
      '-g',
      '@anthropic-ai/claude-code',
      '--prefix',
      '/Users/tester/.local'
    ])
  })

  it('pipes the official installer through bash on Unix', () => {
    const spec = getInstallSpawnSpec('official-script', 'linux')

    expect(spec.command).toBe('bash')
    expect(spec.args.at(-1)).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('runs npm through a shell on Windows (npm.cmd shim) without a prefix override', () => {
    const spec = getInstallSpawnSpec('npm', 'win32', 'C:\\Users\\tester')

    expect(spec.command).toBe('npm')
    // Windows global npm bin (%APPDATA%\npm) is already user-writable, so no --prefix is needed.
    expect(spec.args).toEqual(['i', '-g', '@anthropic-ai/claude-code'])
    expect(spec.shell).toBe(true)
  })

  it('uses the PowerShell installer (install.ps1) on Windows', () => {
    const spec = getInstallSpawnSpec('official-script', 'win32')

    expect(spec.command).toBe('powershell')
    expect(spec.args.at(-1)).toContain('irm https://claude.ai/install.ps1 | iex')
  })
})

describe('claude-install: region-block detection', () => {
  it('flags piped-HTML region-block output', () => {
    expect(isRegionBlockedOutput('<!DOCTYPE html><html>App unavailable in region</html>')).toBe(
      true
    )
    expect(isRegionBlockedOutput("bash: line 1: syntax error near unexpected token `<'")).toBe(true)
    expect(isRegionBlockedOutput('App unavailable in region | Claude by Anthropic')).toBe(true)
  })

  it('does not flag ordinary installer output', () => {
    expect(isRegionBlockedOutput('added 1 package in 3s')).toBe(false)
    expect(isRegionBlockedOutput('npm warn deprecated foo@1.0.0')).toBe(false)
    expect(isRegionBlockedOutput('')).toBe(false)
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

  it('marks an official-script failure region-blocked when it pipes HTML', async () => {
    const child = new FakeChild()
    const promise = runInstall({
      source: 'official-script',
      installId: 'install-4',
      onLog: () => undefined,
      spawnImpl: () => child as never
    })

    child.stderr.emit('data', Buffer.from("bash: line 1: syntax error near unexpected token `<'"))
    child.emit('exit', 2)

    await expect(promise).resolves.toMatchObject({ ok: false, regionBlocked: true })
  })

  it('does not mark an ordinary npm failure region-blocked', async () => {
    const child = new FakeChild()
    const promise = runInstall({
      source: 'npm',
      installId: 'install-5',
      onLog: () => undefined,
      spawnImpl: () => child as never
    })

    child.stderr.emit('data', Buffer.from('npm error code EACCES'))
    child.emit('exit', 1)

    const result = await promise

    expect(result.ok).toBe(false)
    expect(result.regionBlocked).toBeFalsy()
  })
})

describe('claude-install: run with region-block fallback', () => {
  it('falls back to npm when the official script is region-blocked and npm is available', async () => {
    const { spawn, commands } = scriptedSpawn({
      bash: { stderr: "syntax error near unexpected token `<'", exit: 2 },
      npm: { stdout: 'added 1 package', exit: 0 }
    })
    const logs: ClaudeInstallLogEvent[] = []

    const result = await runInstallWithFallback({
      source: 'official-script',
      installId: 'install-6',
      onLog: (event) => logs.push(event),
      spawnImpl: spawn as never,
      npmProbe: () => Promise.resolve()
    })

    expect(commands).toEqual(['bash', 'npm'])
    expect(result.ok).toBe(true)
    expect(logs.some((log) => log.stream === 'system' && /region/i.test(log.chunk))).toBe(true)
  })

  it('does not fall back when npm is unavailable', async () => {
    const { spawn, commands } = scriptedSpawn({
      bash: { stderr: "syntax error near unexpected token `<'", exit: 2 }
    })

    const result = await runInstallWithFallback({
      source: 'official-script',
      installId: 'install-7',
      onLog: () => undefined,
      spawnImpl: spawn as never,
      npmProbe: () => Promise.reject(new Error('not found'))
    })

    expect(commands).toEqual(['bash'])
    expect(result.ok).toBe(false)
    expect(result.regionBlocked).toBe(true)
  })

  it('does not fall back on a non-region-block failure', async () => {
    const { spawn, commands } = scriptedSpawn({
      bash: { stderr: 'curl: (7) Failed to connect', exit: 1 }
    })

    const result = await runInstallWithFallback({
      source: 'official-script',
      installId: 'install-8',
      onLog: () => undefined,
      spawnImpl: spawn as never,
      npmProbe: () => Promise.resolve()
    })

    expect(commands).toEqual(['bash'])
    expect(result.ok).toBe(false)
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
