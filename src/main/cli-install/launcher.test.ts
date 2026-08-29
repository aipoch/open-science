import { spawnSync } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdescribe = describe.skipIf(process.platform === 'win32')
const symlinkDescribe = describe.skipIf(process.platform === 'win32')

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

const WINDOWS_PATH_RECEIPT_OWNER = 'Open Science Windows PATH entry. Managed by the app.'
const windowsPathPendingPath = (env: CliLauncherEnv): string =>
  join(planCliLauncher(env).binDir, '.open-science-path-pending')
const windowsPathReceiptPath = (env: CliLauncherEnv): string =>
  join(planCliLauncher(env).binDir, '.open-science-path-receipt')
const writeWindowsPathJournal = async (
  env: CliLauncherEnv,
  state: 'pending' | 'owned' = 'owned',
  beforePath = 'C:\\Windows\\System32'
): Promise<void> => {
  const binDir = planCliLauncher(env).binDir
  await writeFile(
    state === 'pending' ? windowsPathPendingPath(env) : windowsPathReceiptPath(env),
    JSON.stringify({
      version: 1,
      owner: WINDOWS_PATH_RECEIPT_OWNER,
      binDir,
      beforePath,
      afterPath: `${beforePath};${binDir}`
    })
  )
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'os-cli-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

describe('planCliLauncher', () => {
  it('targets ~/.local/bin with an executable sh shim on POSIX', () => {
    const plan = planCliLauncher(posixEnv())
    expect(plan.target).toBe(join(home, '.local', 'bin', 'open-science'))
    expect(plan.mode).toBe(0o755)
    expect(plan.shim).toContain('#!/bin/sh')
    expect(plan.shim).toContain('Format version: 1')
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

  it('mounts the stable AppImage without passing Node flags through AppRun', () => {
    const plan = planCliLauncher(
      posixEnv({
        appExecPath: '/tmp/.mount_open-scienceOLD/open-science',
        cliEntryPath: '/tmp/.mount_open-scienceOLD/resources/cli/index.mjs',
        appImagePath: "/home/alice/Open Science's build.AppImage"
      })
    )

    expect(plan.shim).toContain("app_image='/home/alice/Open Science'\\''s build.AppImage'")
    expect(plan.shim).toContain('"$app_image" --appimage-mount')
    expect(plan.shim).toContain('app_exec="$mount_dir"/\'open-science\'')
    expect(plan.shim).toContain('cli_entry="$mount_dir"/\'resources/cli/index.mjs\'')
    expect(plan.shim).toContain('"$app_exec" "$cli_entry" "$@"')
    expect(plan.shim).not.toContain(' -e ')
    expect(plan.shim).not.toContain('/tmp/.mount_open-scienceOLD')
  })

  it('rejects AppImage payload paths outside the current mount', () => {
    expect(() =>
      planCliLauncher(
        posixEnv({
          appExecPath: '/tmp/.mount_open-science/open-science',
          cliEntryPath: '/opt/Open Science/resources/cli/index.mjs',
          appImagePath: '/home/alice/Open Science.AppImage'
        })
      )
    ).toThrow('inside the current AppImage mount')
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

  it('preserves an existing managed launcher when replacement writing fails', async () => {
    const originalEnv = posixEnv()
    const originalPlan = planCliLauncher(originalEnv)
    await mkdir(originalPlan.binDir, { recursive: true })
    await writeFile(originalPlan.target, originalPlan.shim, { mode: 0o755 })
    const originalMode = (await stat(originalPlan.target)).mode & 0o777

    const probe = await open(join(home, 'file-handle-probe'), 'w')
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { write: typeof probe.write }
    await probe.close()
    vi.spyOn(fileHandlePrototype, 'write').mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    )

    await expect(
      installCliLauncher(
        posixEnv({ appExecPath: '/opt/Open Science/open-science-next' }),
        () => true
      )
    ).rejects.toMatchObject({ code: 'ENOSPC' })

    await expect(readFile(originalPlan.target, 'utf8')).resolves.toBe(originalPlan.shim)
    expect((await stat(originalPlan.target)).mode & 0o777).toBe(originalMode)
    await expect(readdir(originalPlan.binDir)).resolves.toEqual(['open-science'])
  })

  it('revalidates the open managed launcher after flushing replacement bytes', async () => {
    const originalEnv = posixEnv()
    const originalPlan = planCliLauncher(originalEnv)
    await installCliLauncher(originalEnv)

    const probe = await open(join(home, 'file-handle-probe'), 'w')
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat
      sync: typeof probe.sync
    }
    const originalStat = fileHandlePrototype.stat
    const originalSync = fileHandlePrototype.sync
    await probe.close()
    const events: Array<{ operation: 'stat' | 'sync'; fd: number }> = []
    vi.spyOn(fileHandlePrototype, 'stat').mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      events.push({ operation: 'stat', fd: this.fd })
      return originalStat.apply(this, args)
    })
    vi.spyOn(fileHandlePrototype, 'sync').mockImplementation(async function (
      this: FileHandle,
      ...args
    ) {
      events.push({ operation: 'sync', fd: this.fd })
      return originalSync.apply(this, args)
    })

    const nextEnv = posixEnv({ appExecPath: '/opt/Open Science/open-science-next' })
    await installCliLauncher(nextEnv)

    const validatedFd = events.find((event) => event.operation === 'stat')?.fd
    const flushedAt = events.findIndex((event) => event.operation === 'sync')
    expect(validatedFd).toBeTypeOf('number')
    expect(flushedAt).toBeGreaterThanOrEqual(0)
    expect(events.slice(flushedAt + 1)).toContainEqual({ operation: 'stat', fd: validatedFd })
    await expect(readFile(originalPlan.target, 'utf8')).resolves.toBe(planCliLauncher(nextEnv).shim)
  })
})

describe.each([
  ['POSIX', () => posixEnv()],
  ['Windows', () => winEnv()]
])('unmanaged same-name launcher safety (%s)', (_platform, createEnv) => {
  it('refuses to overwrite an unmanaged launcher during install', async () => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    const userContent = 'user-managed launcher\n'
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, userContent)

    await expect(installCliLauncher(env, () => true)).rejects.toThrow(
      'because it is not managed by Open Science'
    )
    await expect(readFile(plan.target, 'utf8')).resolves.toBe(userContent)
  })

  it('refuses to remove an unmanaged launcher during uninstall', async () => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    const userContent = 'user-managed launcher\n'
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, userContent)

    await expect(uninstallCliLauncher(env)).rejects.toThrow(
      'because it is not managed by Open Science'
    )
    await expect(readFile(plan.target, 'utf8')).resolves.toBe(userContent)
  })

  it('does not report an unmanaged launcher as installed', async () => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, 'user-managed launcher\n')

    await expect(getCliLauncherStatus(env)).resolves.toMatchObject({
      installed: false,
      target: plan.target
    })
  })

  it('does not treat marker text embedded in arbitrary content as app ownership', async () => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    const userContent = [
      'user-managed launcher',
      'Open Science command-line launcher. Managed by the app',
      'still user-managed'
    ].join('\n')
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, userContent)

    await expect(installCliLauncher(env, () => true)).rejects.toThrow(
      'because it is not managed by Open Science'
    )
    await expect(readFile(plan.target, 'utf8')).resolves.toBe(userContent)
  })

  it('continues to update and remove launchers carrying the historical ownership marker', async () => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    const legacyContent =
      env.platform === 'win32'
        ? [
            '@echo off',
            'rem Open Science command-line launcher. Managed by the app; edits are overwritten on reinstall.',
            'set ELECTRON_RUN_AS_NODE=1',
            'legacy launcher'
          ].join('\r\n')
        : [
            '#!/bin/sh',
            '# Open Science command-line launcher. Managed by the app (Settings -> General -> Command line',
            "# tool); edits will be overwritten on reinstall. Runs the app's Electron in Node mode.",
            'legacy launcher'
          ].join('\n')
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, legacyContent)

    await expect(getCliLauncherStatus(env)).resolves.toMatchObject({ installed: true })
    await installCliLauncher(env, () => true)
    await expect(readFile(plan.target, 'utf8')).resolves.toBe(plan.shim)
    await uninstallCliLauncher(env, () => true)
    await expect(readFile(plan.target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

symlinkDescribe('symlinked launcher safety', () => {
  const arrangeManagedTargetSymlink = async (): Promise<{
    env: CliLauncherEnv
    target: string
    userFile: string
    userContent: string
  }> => {
    const env = posixEnv()
    const plan = planCliLauncher(env)
    const userFile = join(home, 'user-script')
    const userContent = 'Open Science command-line launcher. Managed by the app\nuser content\n'
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(userFile, userContent)
    await symlink(userFile, plan.target, 'file')
    return { env, target: plan.target, userFile, userContent }
  }

  it('does not report a symlink to marker-bearing user content as installed', async () => {
    const { env } = await arrangeManagedTargetSymlink()

    await expect(getCliLauncherStatus(env)).resolves.toMatchObject({ installed: false })
  })

  it('refuses to follow a symlink during install', async () => {
    const { env, target, userFile, userContent } = await arrangeManagedTargetSymlink()

    await expect(installCliLauncher(env)).rejects.toThrow('not managed by Open Science')
    await expect(readFile(userFile, 'utf8')).resolves.toBe(userContent)
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
  })

  it('refuses to remove a symlink during uninstall', async () => {
    const { env, target, userFile, userContent } = await arrangeManagedTargetSymlink()

    await expect(uninstallCliLauncher(env)).rejects.toThrow('not managed by Open Science')
    await expect(readFile(userFile, 'utf8')).resolves.toBe(userContent)
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
  })
})

describe('hard-linked launcher safety', () => {
  const arrangeManagedTargetHardLink = async (): Promise<{
    env: CliLauncherEnv
    target: string
    userFile: string
    userContent: string
  }> => {
    const env = posixEnv()
    const plan = planCliLauncher(env)
    const userFile = join(home, 'user-script')
    const userContent = 'Open Science command-line launcher. Managed by the app\nuser content\n'
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(userFile, userContent)
    await link(userFile, plan.target)
    return { env, target: plan.target, userFile, userContent }
  }

  it('does not report a hard link to marker-bearing user content as installed', async () => {
    const { env } = await arrangeManagedTargetHardLink()

    await expect(getCliLauncherStatus(env)).resolves.toMatchObject({ installed: false })
  })

  it('refuses to follow a hard link during install', async () => {
    const { env, userFile, userContent } = await arrangeManagedTargetHardLink()

    await expect(installCliLauncher(env)).rejects.toThrow('not managed by Open Science')
    await expect(readFile(userFile, 'utf8')).resolves.toBe(userContent)
  })

  it('refuses to remove a hard link during uninstall', async () => {
    const { env, target, userFile, userContent } = await arrangeManagedTargetHardLink()

    await expect(uninstallCliLauncher(env)).rejects.toThrow('not managed by Open Science')
    await expect(readFile(userFile, 'utf8')).resolves.toBe(userContent)
    await expect(lstat(target)).resolves.toMatchObject({ nlink: 2 })
  })
})

describe('buildWindowsPathCommand', () => {
  it('embeds the bin dir as a PowerShell literal, not via -args', () => {
    const binDir = 'C:\\Users\\me\\AppData\\Roaming\\Open Science\\bin'
    const { command, args } = buildWindowsPathCommand(binDir)
    expect(command).toBe('powershell')
    // The script must be passed to -Command and contain the actual dir literal; -args (the fragile
    // form that could leave $args empty and write the wrong PATH) must not be used.
    expect(args).toContain('-Command')
    expect(args).not.toContain('-args')
    const script = args[args.length - 1]
    expect(script).toContain(`$binDir = '${binDir}'`)
    expect(script).toContain(`$pendingPath = '${join(binDir, '.open-science-path-pending')}'`)
    expect(script).toContain(
      `$pendingTempPath = '${join(binDir, '.open-science-path-pending.tmp')}'`
    )
    expect(script).toContain(`$receiptPath = '${join(binDir, '.open-science-path-receipt')}'`)
    expect(script).toContain(`$receiptOwner = '${WINDOWS_PATH_RECEIPT_OWNER}'`)
    expect(script).toContain("TrimEnd([char[]]'\\/') -ieq $normalizedBinDir")
    expect(script).toContain("[Environment]::SetEnvironmentVariable('Path'")
    expect(script).toContain(
      '$stream = [IO.File]::Open($pendingTempPath, [IO.FileMode]::CreateNew,'
    )
    expect(script).toContain(
      'if ([IO.File]::Exists($pendingTempPath)) { [IO.File]::Delete($pendingTempPath) }'
    )
    expect(script.indexOf('$stream.Flush($true)')).toBeLessThan(
      script.indexOf('[IO.File]::Move($pendingTempPath, $pendingPath)')
    )
    expect(script.indexOf('[IO.File]::Move($pendingTempPath, $pendingPath)')).toBeLessThan(
      script.lastIndexOf("[Environment]::SetEnvironmentVariable('Path', $next")
    )
    expect(script.lastIndexOf("[Environment]::SetEnvironmentVariable('Path', $next")).toBeLessThan(
      script.lastIndexOf('[IO.File]::Move($pendingPath, $receiptPath)')
    )
    expect(script).toContain("throw 'The pending PATH ownership journal cannot be reconciled.'")
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
    const status = await installCliLauncher(
      winEnv({ pathVar: `C:\\Windows;${binDir.toUpperCase()}\\` }),
      () => {
        called = true
        return true
      }
    )
    expect(called).toBe(false)
    expect(status.onPath).toBe(true)
    expect(status.pathHint).toBeUndefined()
  })
})

describe('uninstallCliLauncher on Windows PATH edit', () => {
  it('cleans up an owned PATH entry even when the managed shim is already missing', async () => {
    const env = winEnv()
    await mkdir(planCliLauncher(env).binDir, { recursive: true })
    await writeWindowsPathJournal(env)
    const runCommand = vi.fn(() => true)

    const status = await uninstallCliLauncher(env, runCommand)

    expect(runCommand).toHaveBeenCalledOnce()
    expect(status).toMatchObject({ installed: false, onPath: false })
    await expect(readFile(windowsPathReceiptPath(env), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('preserves the shim and aborts when an existing PATH journal is unmanaged', async () => {
    const env = winEnv()
    await installCliLauncher(env, () => true)
    await writeFile(windowsPathReceiptPath(env), 'user-owned content')
    const runCommand = vi.fn(() => true)

    await expect(uninstallCliLauncher(env, runCommand)).rejects.toThrow(
      'because it is not managed by Open Science'
    )

    expect(runCommand).not.toHaveBeenCalled()
    await expect(readFile(planCliLauncher(env).target, 'utf8')).resolves.toContain(
      'Managed by the app'
    )
    await expect(readFile(windowsPathReceiptPath(env), 'utf8')).resolves.toBe('user-owned content')
  })

  it('removes the owned PATH entry before deleting the managed shim', async () => {
    const env = winEnv()
    await installCliLauncher(env, () => true)
    await writeWindowsPathJournal(env)
    const calls: Array<{ command: string; args: string[] }> = []

    const status = await uninstallCliLauncher(env, (command, args) => {
      calls.push({ command, args })
      return true
    })

    expect(calls).toHaveLength(1)
    const script = calls[0].args.at(-1) ?? ''
    expect(script).toContain("$state = 'owned'")
    expect(script).toContain('$matches = @($parts | Where-Object')
    expect(script).toContain("TrimEnd([char[]]'\\/') -ieq $normalizedBinDir")
    expect(script).toContain(
      "throw 'The owned PATH entry no longer matches its recorded snapshot.'"
    )
    expect(script).toContain("SetEnvironmentVariable('Path', $beforePath, 'User')")
    expect(status).toMatchObject({ installed: false, onPath: false })
    await expect(readFile(planCliLauncher(env).target, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(windowsPathReceiptPath(env), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('fails closed when ownership continuity no longer matches the recorded snapshot', async () => {
    const env = winEnv()
    await installCliLauncher(env, () => true)
    await writeWindowsPathJournal(env)

    await expect(
      uninstallCliLauncher(env, (_command, args) => {
        expect(args.at(-1)).toContain(
          "throw 'The owned PATH entry no longer matches its recorded snapshot.'"
        )
        return false
      })
    ).rejects.toThrow('Could not remove')
    await expect(readFile(planCliLauncher(env).target, 'utf8')).resolves.toContain(
      'Managed by the app'
    )
    await expect(readFile(windowsPathReceiptPath(env), 'utf8')).resolves.toContain(
      WINDOWS_PATH_RECEIPT_OWNER
    )
  })

  it('reconciles a pending journal only when PATH matches its before or after snapshot', async () => {
    const env = winEnv()
    await installCliLauncher(env, () => true)
    await writeWindowsPathJournal(env, 'pending')
    const calls: Array<{ command: string; args: string[] }> = []

    await uninstallCliLauncher(env, (command, args) => {
      calls.push({ command, args })
      return true
    })

    const script = calls[0].args.at(-1) ?? ''
    expect(script).toContain("$state = 'pending'")
    expect(script).toContain('if ($current -ceq $beforePath) { return }')
    expect(script).toContain('if ($current -cne $afterPath)')
    await expect(readFile(windowsPathPendingPath(env), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('preserves a pre-existing user PATH entry when no ownership receipt exists', async () => {
    const binDir = join(home, 'AppData', 'Roaming', 'Open Science', 'bin')
    const env = winEnv({ pathVar: `C:\\Windows;${binDir.toUpperCase()}\\` })
    const runCommand = vi.fn(() => true)
    await installCliLauncher(env, runCommand)

    const status = await uninstallCliLauncher(env, runCommand)

    expect(runCommand).not.toHaveBeenCalled()
    expect(status).toMatchObject({ installed: false, onPath: false })
    await expect(readFile(windowsPathReceiptPath(env), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(planCliLauncher(env).target, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

pdescribe('AppImage launcher reconciliation (POSIX)', () => {
  const appImageEnv = (overrides: Partial<CliLauncherEnv> = {}): CliLauncherEnv =>
    posixEnv({
      appExecPath: '/tmp/.mount_open-scienceNEW/open-science',
      cliEntryPath: '/tmp/.mount_open-scienceNEW/resources/cli/index.mjs',
      appImagePath: '/home/alice/Open Science.AppImage',
      ...overrides
    })

  it('returns false when no shim exists', async () => {
    expect(await isCliShimStale(appImageEnv())).toBe(false)
  })

  it('returns false when the stable AppImage shim is current', async () => {
    await installCliLauncher(appImageEnv())
    expect(await isCliShimStale(appImageEnv())).toBe(false)
  })

  it('runs the CLI through the mounted payload and cleans up the mount process', async () => {
    const mountDir = join(home, 'mounted AppImage')
    const appImagePath = join(home, "Open Science's build.AppImage")
    const resultPath = join(home, 'cli-result.txt')
    const stoppedPath = join(home, 'mount-stopped.txt')
    const cliDir = join(mountDir, 'resources', 'cli')
    await mkdir(cliDir, { recursive: true })
    await writeFile(
      appImagePath,
      [
        '#!/bin/sh',
        '[ "$1" = "--appimage-mount" ] || exit 90',
        'printf "%s\\n" "$FAKE_MOUNT_DIR"',
        'trap \'printf stopped > "$FAKE_STOPPED"; exit 0\' 1 2 15',
        'while :; do sleep 0.05; done'
      ].join('\n'),
      { mode: 0o755 }
    )
    await writeFile(
      join(mountDir, 'open-science'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$OPEN_SCIENCE_APP_PATH" > "$FAKE_RESULT"',
        'printf "%s\\n" "$ELECTRON_RUN_AS_NODE" >> "$FAKE_RESULT"',
        'printf "%s\\n" "$@" >> "$FAKE_RESULT"',
        'exit 23'
      ].join('\n'),
      { mode: 0o755 }
    )
    await writeFile(join(cliDir, 'index.mjs'), '')

    const env = appImageEnv({
      appExecPath: '/tmp/.mount_current/open-science',
      cliEntryPath: '/tmp/.mount_current/resources/cli/index.mjs',
      appImagePath
    })
    await installCliLauncher(env)
    const run = spawnSync(planCliLauncher(env).target, ['--help', 'two words'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_MOUNT_DIR: mountDir,
        FAKE_RESULT: resultPath,
        FAKE_STOPPED: stoppedPath
      },
      timeout: 10_000
    })

    expect(run).toMatchObject({ status: 23, signal: null })
    expect((await readFile(resultPath, 'utf8')).trim().split('\n')).toEqual([
      appImagePath,
      '1',
      join(mountDir, 'resources', 'cli', 'index.mjs'),
      '--help',
      'two words'
    ])
    await expect(readFile(stoppedPath, 'utf8')).resolves.toBe('stopped')
  })

  it('detects and migrates a legacy shim that pins an old FUSE mount', async () => {
    await installCliLauncher(posixEnv())
    const env = appImageEnv()

    expect(await isCliShimStale(env)).toBe(true)
    const result = await ensureCliLauncherCurrent(env)
    expect(result).toMatchObject({ installed: true })

    const shim = await readFile(result!.target, 'utf8')
    expect(shim).toContain("app_image='/home/alice/Open Science.AppImage'")
    expect(shim).not.toContain('/tmp/.mount_open-scienceNEW')
  })

  it('updates the stable shim after the AppImage file moves', async () => {
    await installCliLauncher(appImageEnv())
    const moved = appImageEnv({ appImagePath: '/home/alice/Applications/Open Science.AppImage' })

    expect(await isCliShimStale(moved)).toBe(true)
    await ensureCliLauncherCurrent(moved)
    expect(await readFile(planCliLauncher(moved).target, 'utf8')).toContain(
      "app_image='/home/alice/Applications/Open Science.AppImage'"
    )
  })

  it('does nothing when shim is up to date', async () => {
    await installCliLauncher(appImageEnv())
    const result = await ensureCliLauncherCurrent(appImageEnv())
    expect(result).toBeUndefined()
  })

  it('reports a legacy AppImage shim as not installed until reconciliation succeeds', async () => {
    await installCliLauncher(posixEnv())
    expect(await getCliLauncherStatus(appImageEnv())).toMatchObject({ installed: false })
  })

  it('does not overwrite an unmanaged launcher', async () => {
    const env = appImageEnv()
    const plan = planCliLauncher(env)
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, '#!/bin/sh\necho custom\n')

    expect(await isCliShimStale(env)).toBe(false)
    expect(await ensureCliLauncherCurrent(env)).toBeUndefined()
    expect(await readFile(plan.target, 'utf8')).toBe('#!/bin/sh\necho custom\n')
  })

  it('does nothing when CLI is not installed', async () => {
    const result = await ensureCliLauncherCurrent(appImageEnv())
    expect(result).toBeUndefined()
  })
})

describe('AppImage reconciliation platform boundary', () => {
  it.each([
    ['win32', () => winEnv({ appImagePath: 'C:\\Users\\me\\Open Science.AppImage' })],
    [
      'darwin',
      () => posixEnv({ platform: 'darwin', appImagePath: '/Applications/Open Science.AppImage' })
    ]
  ])('does not rewrite a packaged %s launcher', async (_platform, createEnv) => {
    const env = createEnv()
    const plan = planCliLauncher(env)
    await mkdir(plan.binDir, { recursive: true })
    await writeFile(plan.target, 'user-managed launcher')

    expect(await isCliShimStale(env)).toBe(false)
    expect(await ensureCliLauncherCurrent(env)).toBeUndefined()
    expect(await readFile(plan.target, 'utf8')).toBe('user-managed launcher')
  })
})
