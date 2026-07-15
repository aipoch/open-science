import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ClaudeInstallEvent } from '../../shared/settings'
import {
  detectNpmAvailable,
  getInstallSpawnSpec,
  isNpmGlobalPrefixWritable,
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
      if (script?.stdout) child.stdout.emit('data', Buffer.from(script.stdout))
      if (script?.stderr) child.stderr.emit('data', Buffer.from(script.stderr))
      child.emit('exit', script?.exit ?? 0)
    })

    return child
  }

  return { spawn, commands }
}

describe('claude-install: command construction', () => {
  it('runs a plain global npm install (no --prefix) on Unix by default', () => {
    const spec = getInstallSpawnSpec('npm', 'linux')

    expect(spec.command).toBe('npm')
    // With a writable default global prefix (Homebrew/nvm/volta), no override is needed.
    expect(spec.args).toEqual(['i', '-g', '@anthropic-ai/claude-code'])
    expect(spec.args.includes('--prefix')).toBe(false)
    expect(spec.args.some((arg) => arg.includes('--registry'))).toBe(false)
    expect(spec.shell).toBeFalsy()
  })

  it('appends --prefix when a user-writable override is provided on Unix', () => {
    const spec = getInstallSpawnSpec('npm', 'linux', '/home/tester/.local')

    // The override is used only when the caller determined the default prefix needs sudo.
    expect(spec.args).toEqual([
      'i',
      '-g',
      '@anthropic-ai/claude-code',
      '--prefix',
      '/home/tester/.local'
    ])
  })

  it('honours the override on macOS too', () => {
    const spec = getInstallSpawnSpec('npm', 'darwin', '/Users/tester/.local')

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

  it('runs npm through a shell on Windows (npm.cmd shim) and never adds a --prefix', () => {
    // Even if an override is passed, Windows must ignore it (%APPDATA%\npm is already user-writable).
    const spec = getInstallSpawnSpec('npm', 'win32', 'C:\\Users\\tester\\.local')

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
    const logs: ClaudeInstallEvent[] = []
    const promise = runInstall({
      source: 'npm',
      installId: 'install-1',
      onEvent: (event) => logs.push(event),
      spawnImpl: () => child as never,
      npmPrefixWritable: () => Promise.resolve(true)
    })

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('adding package\n'))
      child.stderr.emit('data', Buffer.from('warn\n'))
      child.emit('exit', 0)
    })

    const result = await promise

    expect(result).toMatchObject({ installId: 'install-1', ok: true, exitCode: 0 })
    expect(
      logs.some(
        (e) => e.kind === 'log' && e.stream === 'stdout' && e.chunk.includes('adding package')
      )
    ).toBe(true)
    expect(logs.some((e) => e.kind === 'log' && e.stream === 'stderr')).toBe(true)
  })

  it('resolves not ok on a non-zero exit', async () => {
    const child = new FakeChild()
    const promise = runInstall({
      source: 'npm',
      installId: 'install-2',
      onEvent: () => undefined,
      spawnImpl: () => child as never,
      npmPrefixWritable: () => Promise.resolve(true)
    })

    setImmediate(() => child.emit('exit', 1))

    await expect(promise).resolves.toMatchObject({ ok: false, exitCode: 1 })
  })

  it('reports a spawn failure without throwing', async () => {
    const result = await runInstall({
      source: 'npm',
      installId: 'install-3',
      onEvent: () => undefined,
      npmPrefixWritable: () => Promise.resolve(true),
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
      onEvent: () => undefined,
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
      onEvent: () => undefined,
      spawnImpl: () => child as never,
      npmPrefixWritable: () => Promise.resolve(true)
    })

    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('npm error code EACCES'))
      child.emit('exit', 1)
    })

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
    const logs: ClaudeInstallEvent[] = []

    const result = await runInstallWithFallback({
      source: 'official-script',
      installId: 'install-6',
      onEvent: (event) => logs.push(event),
      spawnImpl: spawn as never,
      platform: 'linux',
      npmProbe: () => Promise.resolve(),
      npmPrefixWritable: () => Promise.resolve(true)
    })

    expect(commands).toEqual(['bash', 'npm'])
    expect(result.ok).toBe(true)
    expect(
      logs.some((e) => e.kind === 'log' && e.stream === 'system' && /region/i.test(e.chunk))
    ).toBe(true)
  })

  it('does not fall back when npm is unavailable', async () => {
    const { spawn, commands } = scriptedSpawn({
      bash: { stderr: "syntax error near unexpected token `<'", exit: 2 }
    })

    const result = await runInstallWithFallback({
      source: 'official-script',
      installId: 'install-7',
      onEvent: () => undefined,
      spawnImpl: spawn as never,
      platform: 'linux',
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
      onEvent: () => undefined,
      spawnImpl: spawn as never,
      platform: 'linux',
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

describe('claude-install: npm global prefix writability', () => {
  it('reports writable when the prefix resolves and fs.access succeeds', async () => {
    await expect(
      isNpmGlobalPrefixWritable({
        runNpmPrefix: () => Promise.resolve({ stdout: '/opt/homebrew\n' }),
        access: () => Promise.resolve()
      })
    ).resolves.toBe(true)
  })

  it('reports not writable when fs.access rejects (root-owned prefix)', async () => {
    await expect(
      isNpmGlobalPrefixWritable({
        runNpmPrefix: () => Promise.resolve({ stdout: '/usr/local\n' }),
        access: () => Promise.reject(new Error('EACCES'))
      })
    ).resolves.toBe(false)
  })

  it('reports not writable when `npm prefix -g` fails (safe fallback)', async () => {
    await expect(
      isNpmGlobalPrefixWritable({
        runNpmPrefix: () => Promise.reject(new Error('npm not found')),
        access: () => Promise.resolve()
      })
    ).resolves.toBe(false)
  })

  it('reports not writable when the resolved prefix is empty', async () => {
    await expect(
      isNpmGlobalPrefixWritable({
        runNpmPrefix: () => Promise.resolve({ stdout: '   \n' }),
        access: () => Promise.resolve()
      })
    ).resolves.toBe(false)
  })
})

describe('claude-install: run redirects npm prefix only when needed', () => {
  // Captures the args passed to the spawned command, then exits 0 on the next tick so runInstall's
  // listeners (attached after the async prefix probe) are already in place.
  const capturingSpawn = (): {
    spawn: (command: string, args: string[]) => FakeChild
    args: () => string[]
  } => {
    let captured: string[] = []
    const spawn = (_command: string, args: string[]): FakeChild => {
      captured = args
      const child = new FakeChild()

      setImmediate(() => child.emit('exit', 0))

      return child
    }

    return { spawn, args: () => captured }
  }

  it('adds --prefix ~/.local when the global prefix is not writable', async () => {
    const { spawn, args } = capturingSpawn()

    await runInstall({
      source: 'npm',
      installId: 'install-prefix-1',
      onEvent: () => undefined,
      spawnImpl: spawn as never,
      platform: 'linux',
      npmPrefixWritable: () => Promise.resolve(false)
    })

    expect(args()).toEqual([
      'i',
      '-g',
      '@anthropic-ai/claude-code',
      '--prefix',
      join(homedir(), '.local')
    ])
  })

  it('omits --prefix when the global prefix is writable', async () => {
    const { spawn, args } = capturingSpawn()

    await runInstall({
      source: 'npm',
      installId: 'install-prefix-2',
      onEvent: () => undefined,
      spawnImpl: spawn as never,
      platform: 'linux',
      npmPrefixWritable: () => Promise.resolve(true)
    })

    expect(args()).toEqual(['i', '-g', '@anthropic-ai/claude-code'])
    expect(args().includes('--prefix')).toBe(false)
  })
})
