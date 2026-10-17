import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'

// Node can rewrite argv, hiding its installation from ps. procfs retains the executable identity.
function isLinuxInstallationExecutable(pid: number, installationRoot: string): boolean {
  try {
    const executable = readlinkSync(`/proc/${pid}/exe`)
    return (
      executable === installationRoot ||
      executable === `${installationRoot} (deleted)` ||
      executable.startsWith(`${installationRoot}/`)
    )
  } catch (cause) {
    // Exited processes/kernel threads have no executable. Other users' executable links may be
    // protected; their command lines and live installation registrations are still checked.
    if (
      ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((cause as NodeJS.ErrnoException).code ?? '')
    )
      return false
    throw new UpdateLifecycleError(
      'installation-busy',
      'Installation executable occupancy could not be inspected.',
      undefined,
      { cause }
    )
  }
}

// Detect pre-registration runtimes as well as current protocol participants. Process-list failure is
// unknown occupancy, never an empty list. The caller excludes only its own Desktop and exact Runtime.
export function inspectInstallationProcesses(installationRoot: string): number[] {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    )
    if (result.status !== 0)
      throw new UpdateLifecycleError(
        'installation-busy',
        'Installation process occupancy could not be inspected.'
      )
    try {
      const rows = JSON.parse(result.stdout)
      return (Array.isArray(rows) ? rows : [rows])
        .filter((row) =>
          `${row.ExecutablePath ?? ''} ${row.CommandLine ?? ''}`
            .toLowerCase()
            .includes(installationRoot.toLowerCase())
        )
        .map((row) => Number(row.ProcessId))
    } catch (cause) {
      throw new UpdateLifecycleError(
        'installation-busy',
        'Installation process occupancy could not be inspected.',
        undefined,
        { cause }
      )
    }
  }
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0)
    throw new UpdateLifecycleError(
      'installation-busy',
      'Installation process occupancy could not be inspected.'
    )
  const pids = new Set<number>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (
      match &&
      (match[2].includes(installationRoot) ||
        (process.platform === 'linux' &&
          isLinuxInstallationExecutable(Number(match[1]), installationRoot)))
    )
      pids.add(Number(match[1]))
  }
  if (process.platform === 'darwin') {
    // Text mappings cover a bundled Node launched through a symlink or a rewritten argv[0].
    const mappings = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-Fpn', '-d', 'txt'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    if (mappings.status !== 0)
      throw new UpdateLifecycleError(
        'installation-busy',
        'Mapped installation files could not be inspected.'
      )
    let pid = 0
    for (const line of mappings.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      if (
        line.startsWith('n') &&
        (line.slice(1) === installationRoot || line.slice(1).startsWith(`${installationRoot}/`))
      )
        pids.add(pid)
    }
  }
  return [...pids]
}

export async function inspectInstallationProcessesAsync(
  installationRoot: string,
  signal?: AbortSignal
): Promise<number[]> {
  const { runVerificationProcess } = await import('./verification-process')
  const run = (command: string, args: string[]): ReturnType<typeof runVerificationProcess> =>
    runVerificationProcess(command, args, { signal, timeoutMs: 15_000 })
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
    ])
    const rows = JSON.parse(stdout)
    return (Array.isArray(rows) ? rows : [rows])
      .filter((row) =>
        `${row.ExecutablePath ?? ''} ${row.CommandLine ?? ''}`
          .toLowerCase()
          .includes(installationRoot.toLowerCase())
      )
      .map((row) => Number(row.ProcessId))
  }
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,command='])
  const pids = new Set<number>()
  for (const line of stdout.split('\n')) {
    signal?.throwIfAborted()
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (
      match &&
      (match[2].includes(installationRoot) ||
        (process.platform === 'linux' &&
          isLinuxInstallationExecutable(Number(match[1]), installationRoot)))
    )
      pids.add(Number(match[1]))
  }
  if (process.platform === 'darwin') {
    const maps = await run('/usr/sbin/lsof', ['-n', '-P', '-Fpn', '-d', 'txt'])
    let pid = 0
    for (const line of maps.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      if (
        line.startsWith('n') &&
        (line.slice(1) === installationRoot || line.slice(1).startsWith(`${installationRoot}/`))
      )
        pids.add(pid)
    }
  }
  return [...pids]
}

/** AppImage extract-and-run keeps its runtime parent alive until Electron exits.
 * Exempt only our direct parent executing the exact outer image for our extracted executable. */
export function inspectOwnedLinuxAppImageLauncher(): number[] {
  if (process.platform !== 'linux' || !process.env.APPIMAGE || !process.env.APPDIR) return []
  try {
    if (
      !realpathSync(process.execPath).startsWith(realpathSync(process.env.APPDIR) + sep) ||
      readlinkSync(`/proc/${process.ppid}/exe`) !== realpathSync(process.env.APPIMAGE)
    )
      return []
    return [process.ppid]
  } catch {
    return []
  }
}

/** Linux zygotes are absent from getAppMetrics(), including the sandboxed nested zygote.
 * Only accept this Desktop's zygote ancestry and exact executable, never arbitrary descendants. */
export function inspectOwnedLinuxZygoteProcesses(): number[] {
  if (process.platform !== 'linux') return []
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0)
    throw new UpdateLifecycleError('installation-busy', 'Zygote ownership could not be inspected.')
  const executable = realpathSync(process.execPath)
  const candidates = result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]) }] : []
  })
  const owned = new Set([process.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const { pid, parent } of candidates) {
      if (owned.has(pid) || !owned.has(parent)) continue
      try {
        if (
          readlinkSync(`/proc/${pid}/exe`) !== executable ||
          // Chromium may flatten argv into one space-separated process title.
          !/(?:^|[\0\s])--type=zygote(?:[\0\s]|$)/.test(
            readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          )
        )
          continue
        owned.add(pid)
        changed = true
      } catch {
        // An unreadable or exited process has no verified ownership exemption.
      }
    }
  }
  owned.delete(process.pid)
  return [...owned]
}

/** Crashpad is reparented on macOS/Linux and is absent from getAppMetrics().
 * Accept only the exact bundled executable, crash database and per-launch annotation.
 * A previous launch (even with the same profile), another profile, or an unannotated
 * handler remains an occupant. This is ownership evidence, not a process-name exemption. */
export function inspectOwnedCrashpadProcesses(options: {
  installationRoot: string
  crashDumpsPath: string
  instanceId: string
}): number[] {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return []
  const read = (field: string): Map<number, string> => {
    const result = spawnSync('/bin/ps', ['-axo', `pid=,${field}=`], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024
    })
    if (result.status !== 0)
      throw new UpdateLifecycleError(
        'installation-busy',
        'Crash reporter ownership could not be inspected.'
      )
    return new Map(
      result.stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        return match ? [[Number(match[1]), match[2]] as const] : []
      })
    )
  }
  const canonical = (path: string): string | undefined => {
    try {
      return realpathSync(path)
    } catch {
      return undefined
    }
  }
  const executable = canonical(
    join(
      options.installationRoot,
      process.platform === 'darwin'
        ? 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
        : 'chrome_crashpad_handler'
    )
  )
  const database = canonical(options.crashDumpsPath)
  if (!executable || !database || !options.instanceId) return []
  const commands = read('comm')
  const argumentsByPid = read('args')
  return [...commands].flatMap(([pid, command]) => {
    if (process.platform === 'linux') {
      try {
        command = readlinkSync(`/proc/${pid}/exe`)
      } catch {
        return []
      }
    }
    if (canonical(command) !== executable) return []
    const args = argumentsByPid.get(pid)?.split(' --')
    if (!args || canonical(args.shift()!) !== executable) return []
    const databases = args.filter((arg) => arg.startsWith('database='))
    const instances = args.filter((arg) => arg.startsWith('annotation=openScienceInstance='))
    return databases.length === 1 &&
      canonical(databases[0].slice('database='.length)) === database &&
      instances.length === 1 &&
      instances[0] === `annotation=openScienceInstance=${options.instanceId}`
      ? [pid]
      : []
  })
}
