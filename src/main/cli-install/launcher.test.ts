import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const pdescribe = describe.skipIf(process.platform === 'win32')

import {
  buildWindowsPathCommand,
  ensureCliLauncherCurrent,
  getCliLauncherStatus,
  installCliLauncher,
  isCliShimStale,
  planCliLauncher,
  uninstallCliLauncher,
  type CliLauncherEnv
} from './launcher'

let home: string

const posixEnv = (overrides: Partial<CliLauncherEnv> = {}): CliLauncherEnv => ({
  platform: 'linux',
  appExecPath: '/opt/Open Science/open-science',
  cliEntryPath: '/opt/Open Science/resources/cli/index.mjs',
  packaged: true,
  homeDir: home,
  userDataDir: join(home, '.config', 'Open Science'),
  pathVar: '/usr/bin',
  ...overrides
})

const winEnv = (overrides: Partial<CliLauncherEnv> = {}): CliLauncherEnv => ({
  platform: 'win32',
  appExecPath: 'C:\\Program Files\\Open Science\\open-science.exe',
  cliEntryPath: 'C:\\Program Files\\Open Science\\resources\\cli\\index.mjs',
  packaged: true,
  homeDir: home,
  userDataDir: join(home, 'AppData', 'Roaming', 'Open Science'),
  pathVar: 'C:\\Windows\\System32',
  ...overrides
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'os-cli-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('planCliLauncher', () => {
  it('targets ~/.local/bin with an executable sh shim on POSIX', () => {
    const plan = planCliLauncher(posixEnv())
    expect(plan.target).toBe(join(home, '.local', 'bin', 'open-science'))
    expect(plan.mode).toBe(0o755)
    expect(plan.shim).toContain('#!/bin/sh')
    expect(plan.shim).toContain('ELECTRON_RUN_AS_NODE=1')
    // Packaged: pins the app path and single-quotes both paths (they contain a space).
    expect(plan.shim).toContain("OPEN_SCIENCE_APP_PATH='/opt/Open Science/open-science'")
    expect(plan.shim).toContain('\'/opt/Open Science/resources/cli/index.mjs\' "$@"')
  })

  it('omits OPEN_SCIENCE_APP_PATH for a development (unpackaged) build', () => {
    const plan = planCliLauncher(posixEnv({ packaged: false }))
    expect(plan.shim).not.toContain('OPEN_SCIENCE_APP_PATH')
  })

  it('single-quotes POSIX paths so shell metacharacters cannot expand or break out', () => {
    // A path with a space, $, backtick, backslash, and a single quote: none may be interpreted, and
    // the embedded quote must be escaped via the '\'' idiom.
    const nasty = "/opt/a b/$(x)`y`\\z/o'brien"
    const plan = planCliLauncher(posixEnv({ appExecPath: nasty, packaged: true }))
    // The whole path sits inside single quotes; the embedded ' is closed-escaped-reopened as '\''.
    expect(plan.shim).toContain("OPEN_SCIENCE_APP_PATH='/opt/a b/$(x)`y`\\z/o'\\''brien'")
  })

  it('uses appExecPath as exec target with cliEntryPath as file argument', () => {
    const plan = planCliLauncher(
      posixEnv({
        appExecPath: '/tmp/.mount_open-scienceOLD/open-science',
        cliEntryPath: '/tmp/.mount_open-scienceOLD/resources/cli/index.mjs'
      })
    )

    // The shim uses the current FUSE mount paths directly (no -e bootstrap).
    expect(plan.shim).toContain("OPEN_SCIENCE_APP_PATH='/tmp/.mount_open-scienceOLD/open-science'")
    expect(plan.shim).toContain(
      "exec '/tmp/.mount_open-scienceOLD/open-science' '/tmp/.mount_open-scienceOLD/resources/cli/index.mjs' \"$@\""
    )
    expect(plan.shim).not.toContain('-e')
    expect(plan.shim).not.toContain('process.resourcesPath')
  })

  it('targets a per-user bin dir with a .cmd shim on Windows', () => {
    const plan = planCliLauncher(
      posixEnv({
        platform: 'win32',
        appExecPath: 'C:\\Program Files\\Open Science\\open-science.exe',
        userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\Open Science'
      })
    )
    expect(plan.target.endsWith('open-science.cmd')).toBe(true)
    expect(plan.shim).toContain('@echo off')
    expect(plan.shim).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(plan.shim).toContain('%*')
  })

  it('reports onPath only when the bin dir is on PATH', () => {
    // Use a drive-less fixture so a host Windows drive colon is not mistaken for the target POSIX
    // PATH separator this injected-platform test is exercising.
    const posixHome = '/home/alice'
    const binDir = join(posixHome, '.local', 'bin')
    expect(planCliLauncher(posixEnv()).onPath).toBe(false)
    expect(
      planCliLauncher(posixEnv({ homeDir: posixHome, pathVar: `/usr/bin:${binDir}` })).onPath
    ).toBe(true)
  })
})

pdescribe('installCliLauncher / status / uninstall (POSIX)', () => {
  it('writes an executable shim and reports a PATH hint when not on PATH', async () => {
    const status = await installCliLauncher(posixEnv())
    expect(status.installed).toBe(true)
    expect(status.onPath).toBe(false)
    expect(status.pathHint).toContain('.local')

    const mode = (await stat(status.target)).mode & 0o777
    expect(mode & 0o100).toBe(0o100) // owner-executable
    expect(await readFile(status.target, 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('reports installed via getStatus, then removes the shim on uninstall', async () => {
    const binDir = join(home, '.local', 'bin')
    const env = posixEnv({ pathVar: binDir })

    await installCliLauncher(env)
    const status = await getCliLauncherStatus(env)
    expect(status.installed).toBe(true)
    expect(status.onPath).toBe(true)
    expect(status.pathHint).toBeUndefined()

    const removed = await uninstallCliLauncher(env)
    expect(removed.installed).toBe(false)
    expect((await getCliLauncherStatus(env)).installed).toBe(false)
  })
})

describe('buildWindowsPathCommand', () => {
  it('embeds the bin dir as a PowerShell literal, not via -args', () => {
    const { command, args } = buildWindowsPathCommand(
      'C:\\Users\\me\\AppData\\Roaming\\Open Science\\bin'
    )
    expect(command).toBe('powershell')
    // The script must be passed to -Command and contain the actual dir literal; -args (the fragile
    // form that could leave $args empty and write the wrong PATH) must not be used.
    expect(args).toContain('-Command')
    expect(args).not.toContain('-args')
    const script = args[args.length - 1]
    expect(script).toContain("$binDir = 'C:\\Users\\me\\AppData\\Roaming\\Open Science\\bin'")
    expect(script).toContain("[Environment]::SetEnvironmentVariable('Path'")
  })

  it("doubles embedded single quotes so a quote in the path can't break out of the literal", () => {
    const script = buildWindowsPathCommand("C:\\weird'dir\\bin").args.at(-1) ?? ''
    expect(script).toContain("$binDir = 'C:\\weird''dir\\bin'")
  })
})

describe('installCliLauncher on Windows PATH edit', () => {
  it('runs the PATH command with the real bin dir and reports the new-terminal hint on success', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const status = await installCliLauncher(winEnv(), (command, args) => {
      calls.push({ command, args })
      return true
    })

    expect(status.installed).toBe(true)
    expect(status.onPath).toBe(true)
    expect(status.pathHint).toContain('new terminal')
    // The injected runner received the actual bin dir embedded in the script (regression guard for
    // the -args passing bug).
    const binDir = join(home, 'AppData', 'Roaming', 'Open Science', 'bin')
    expect(calls).toHaveLength(1)
    expect(calls[0].args.at(-1)).toContain(binDir)
  })

  it('keeps onPath false with an Add-to-PATH hint when the PATH edit fails', async () => {
    const status = await installCliLauncher(winEnv(), () => false)
    expect(status.onPath).toBe(false)
    expect(status.pathHint).toContain('Add ')
    expect(status.pathHint).toContain('PATH')
  })

  it('skips the PATH edit entirely when the bin dir is already on PATH', async () => {
    const binDir = join(home, 'AppData', 'Roaming', 'Open Science', 'bin')
    let called = false
    const status = await installCliLauncher(winEnv({ pathVar: `C:\\Windows;${binDir}` }), () => {
      called = true
      return true
    })
    expect(called).toBe(false)
    expect(status.onPath).toBe(true)
    expect(status.pathHint).toBeUndefined()
  })
})

pdescribe('CLI shim staleness and reconciliation (POSIX)', () => {
  it('returns false when no shim exists', async () => {
    expect(await isCliShimStale(posixEnv())).toBe(false)
  })

  it('returns false when shim matches current appExecPath', async () => {
    await installCliLauncher(posixEnv())
    expect(await isCliShimStale(posixEnv())).toBe(false)
  })

  it('returns true when appExecPath has changed (AppImage re-mount)', async () => {
    await installCliLauncher(posixEnv())
    // Simulate AppImage re-mount: new FUSE path
    const staleEnv = posixEnv({ appExecPath: '/tmp/.mount_open-scienceABCD1234/open-science' })
    expect(await isCliShimStale(staleEnv)).toBe(true)
  })

  it('returns false for non-packaged builds', async () => {
    expect(await isCliShimStale(posixEnv({ packaged: false }))).toBe(false)
  })

  it('reinstalls shim when appExecPath has changed', async () => {
    await installCliLauncher(posixEnv())
    // Simulate AppImage re-mount
    const newEnv = posixEnv({ appExecPath: '/tmp/.mount_open-scienceNEW/open-science' })
    const result = await ensureCliLauncherCurrent(newEnv)
    expect(result).toBeDefined()
    expect(result!.installed).toBe(true)
    // Verify the shim now contains the new path
    const shim = await readFile(result!.target, 'utf8')
    expect(shim).toContain('/tmp/.mount_open-scienceNEW/open-science')
  })

  it('does nothing when shim is up to date', async () => {
    await installCliLauncher(posixEnv())
    const result = await ensureCliLauncherCurrent(posixEnv())
    expect(result).toBeUndefined()
  })

  it('does nothing when CLI is not installed', async () => {
    const result = await ensureCliLauncherCurrent(posixEnv())
    expect(result).toBeUndefined()
  })
})

describe('reconciliation platform boundary', () => {
  it('does not rewrite a packaged win32 launcher', async () => {
    const env = winEnv()
    const plan = planCliLauncher(env)
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, 'user-managed launcher')

    expect(await isCliShimStale(env)).toBe(false)
    expect(await ensureCliLauncherCurrent(env)).toBeUndefined()
    expect(await readFile(plan.target, 'utf8')).toBe('user-managed launcher')
  })

  it('does not rewrite a packaged darwin launcher', async () => {
    const env = posixEnv({ platform: 'darwin' })
    const plan = planCliLauncher(env)
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, 'user-managed launcher')

    expect(await isCliShimStale(env)).toBe(false)
    expect(await ensureCliLauncherCurrent(env)).toBeUndefined()
    expect(await readFile(plan.target, 'utf8')).toBe('user-managed launcher')
  })
})
