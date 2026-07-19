import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getCliLauncherStatus,
  installCliLauncher,
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
    // Packaged: pins the app path and quotes both paths (they contain a space).
    expect(plan.shim).toContain('OPEN_SCIENCE_APP_PATH="/opt/Open Science/open-science"')
    expect(plan.shim).toContain('"/opt/Open Science/resources/cli/index.mjs" "$@"')
  })

  it('omits OPEN_SCIENCE_APP_PATH for a development (unpackaged) build', () => {
    const plan = planCliLauncher(posixEnv({ packaged: false }))
    expect(plan.shim).not.toContain('OPEN_SCIENCE_APP_PATH')
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
    const binDir = join(home, '.local', 'bin')
    expect(planCliLauncher(posixEnv()).onPath).toBe(false)
    expect(planCliLauncher(posixEnv({ pathVar: `/usr/bin${delimiter}${binDir}` })).onPath).toBe(
      true
    )
  })
})

describe('installCliLauncher / status / uninstall (POSIX)', () => {
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
