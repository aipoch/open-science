import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'

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
    if (match && match[2].includes(installationRoot)) pids.add(Number(match[1]))
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
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match && match[2].includes(installationRoot)) pids.add(Number(match[1]))
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

/** Crashpad is reparented to launchd on macOS and is absent from getAppMetrics().
 * Accept only the exact bundled executable, crash database and per-launch annotation.
 * A previous launch (even with the same profile), another profile, or an unannotated
 * handler remains an occupant. This is ownership evidence, not a process-name exemption. */
export function inspectOwnedMacCrashpadProcesses(options: {
  installationRoot: string
  crashDumpsPath: string
  instanceId: string
}): number[] {
  if (process.platform !== 'darwin') return []
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
      'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
    )
  )
  const database = canonical(options.crashDumpsPath)
  if (!executable || !database || !options.instanceId) return []
  const commands = read('comm')
  const argumentsByPid = read('args')
  return [...commands].flatMap(([pid, command]) => {
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
