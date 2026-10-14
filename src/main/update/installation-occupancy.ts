import { spawnSync } from 'node:child_process'
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
