import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  queryWindowsInstallationDirect,
  queryWindowsInstallationDirectSync,
  WindowsInstallationQueryError
} from './windows-installation-processes'

const requireNative = createRequire(__filename)

function queryDiagnostic(
  cause: unknown,
  root: string
): { stage: string; code?: string; exitCode?: number | null; stderr: string } {
  const error = cause as {
    code?: string
    exitCode?: number | null
    stderr?: string
    message?: string
  }
  let stderr = String(error?.stderr ?? '').slice(0, 4096)
  for (const path of [
    root,
    Buffer.from(root, 'utf8').toString('base64'),
    process.env.USERPROFILE,
    process.env.HOME
  ])
    if (path) stderr = stderr.split(path).join('<path>')
  stderr = stderr.replace(
    /(bearer\s+|(?:token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
    '$1<redacted>'
  )
  const stage =
    cause instanceof SyntaxError
      ? 'parse'
      : ['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error?.code ?? '')
        ? 'native-loading'
        : error?.code === 'ETIMEDOUT' || error?.message?.includes('time limit')
          ? 'timeout'
          : error?.code === 'ENOBUFS' || error?.message?.includes('output exceeded')
            ? 'output-limit'
            : error?.exitCode !== undefined
              ? 'query-exit'
              : error?.code === 'ENOENT' || error?.code === 'EACCES'
                ? 'spawn'
                : 'query'
  return { stage, code: error?.code, exitCode: error?.exitCode, stderr: stderr.slice(0, 2048) }
}

function logQueryFailure(cause: unknown, root: string): void {
  createLogger('update').warn(
    'Windows installation occupancy query failed; trying independent Win32 inspection',
    queryDiagnostic(cause, root)
  )
}

// A valid resource list remains positive evidence even when another part of the response fails.
function knownWindowsResourceUsers(stdout: string): number[] {
  try {
    const data = JSON.parse(stdout)
    return Array.isArray(data?.resourcePids)
      ? data.resourcePids.filter(
          (pid: unknown) => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
        )
      : []
  } catch {
    return []
  }
}

// Query the actual files as Restart Manager resources. This is read-only: no RmShutdown,
// process-name matching, or termination authority is granted by the returned PIDs.
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
function windowsInstallationQuery(installationRoot: string): string[] {
  const root = Buffer.from(installationRoot, 'utf8').toString('base64')
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Linq; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class OpenScienceInstallationResources {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public uint ApplicationType; public uint Status; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern uint RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, out uint reasons);
  [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint session);
  static void Check(uint result) { if (result != 0) throw new InvalidOperationException("Installation resource query failed: " + result); }
  public static uint[] Query(string[] files) {
    if (files.Length == 0) return new uint[0];
    uint session; Check(RmStartSession(out session, 0, new StringBuilder(33)));
    try {
      for (int offset=0; offset<files.Length; offset+=256) {
        string[] batch = files.Skip(offset).Take(256).ToArray();
        Check(RmRegisterResources(session, (uint)batch.Length, batch, 0, IntPtr.Zero, 0, IntPtr.Zero));
      }
      uint count=0, needed=0, reasons;
      for (int retry=0; retry<3; retry++) {
        ProcessInfo[] rows = count == 0 ? null : new ProcessInfo[count];
        uint result = RmGetList(session, out needed, ref count, rows, out reasons);
        if (result == 234) { count=needed; continue; }
        Check(result);
        return rows == null ? new uint[0] : rows.Take((int)count).Select(row => row.Process.Pid).Distinct().ToArray();
      }
      throw new InvalidOperationException("Installation resource occupants kept changing.");
    } finally { Check(RmEndSession(session)); }
  }
}
'@
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${root}'))
$item = Get-Item -LiteralPath $root -Force
$files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $root -File -Recurse -Force | ForEach-Object { $_.FullName }) } else { @($item.FullName) }
$users = @([OpenScienceInstallationResources]::Query([string[]]$files))
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath)
ConvertTo-Json -InputObject @{resourcePids=$users;processes=$processes} -Depth 4 -Compress
`
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

function parseWindowsInstallationQuery(stdout: string, root: string): number[] {
  const data: unknown = JSON.parse(stdout)
  if (
    !data ||
    typeof data !== 'object' ||
    !('resourcePids' in data) ||
    !Array.isArray(data.resourcePids) ||
    !('processes' in data) ||
    !Array.isArray(data.processes)
  )
    throw new Error('Incomplete installation resource inspection.')
  const pids = new Set<number>()
  for (const pid of data.resourcePids) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid installation resource PID.')
    pids.add(pid)
  }
  root = root.toLowerCase().replace(/[\\/]+$/, '')
  for (const row of data.processes) {
    if (!row || typeof row !== 'object') throw new Error('Invalid installation process row.')
    const path = typeof row.ExecutablePath === 'string' ? row.ExecutablePath.toLowerCase() : ''
    if (path === root || path.startsWith(root + '\\') || path.startsWith(root + '/')) {
      const pid = Number(row.ProcessId)
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid installation executable PID.')
      pids.add(pid)
    }
  }
  return [...pids]
}

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

function isLinuxInstallationFileUser(pid: number, root: string): boolean {
  const belongs = (path: string): boolean => {
    path = path.replace(/ \(deleted\)$/, '')
    return path === root || path.startsWith(root + '/')
  }
  let unknown: unknown
  const inspect = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
        unknown ??= error
      return undefined
    }
  }
  const maps = inspect(() => readFileSync(`/proc/${pid}/maps`, 'utf8'))
  for (const line of maps?.split('\n') ?? []) {
    const path = /^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(.+)$/.exec(line)?.[1]
    if (path && belongs(path.replace(/\\012/g, '\n'))) return true
  }
  for (const fd of inspect(() => readdirSync(`/proc/${pid}/fd`)) ?? []) {
    const path = inspect(() => readlinkSync(`/proc/${pid}/fd/${fd}`))
    if (path && belongs(path)) return true
  }
  // This helper runs only after argv/exe yielded no installation candidate. An unrelated user's
  // protected process cannot make every ordinary Linux update permanently unavailable. Record
  // the coverage limitation rather than claim whole-machine absence of file users. A registered
  // or path-matched installation candidate remains an occupant in the caller regardless of this
  // optional supplement. Complete cross-user evidence is still a platform acceptance gap.
  if (unknown && ['EACCES', 'EPERM'].includes((unknown as NodeJS.ErrnoException).code ?? '')) {
    createLogger('update').warn('Linux installation file scan coverage limited', {
      pid,
      code: (unknown as NodeJS.ErrnoException).code
    })
  } else if (unknown)
    throw new UpdateLifecycleError(
      'installation-busy',
      `Installation file use could not be verified for process ${pid}. Retry the occupancy check or cancel this update.`,
      undefined,
      { cause: unknown }
    )
  return false
}

// Detect pre-registration runtimes as well as current protocol participants. Process-list failure is
// unknown occupancy, never an empty list. The caller excludes only its own Desktop and exact Runtime.
export function inspectInstallationProcesses(installationRoot: string): number[] {
  try {
    installationRoot = realpathSync(installationRoot) || installationRoot
  } catch {
    /* The installation may already have moved. */
  }
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', windowsInstallationQuery(installationRoot), {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    try {
      if (result.error || result.status !== 0)
        throw new WindowsInstallationQueryError(
          'powershell-query',
          queryDiagnostic(
            {
              code: (result.error as NodeJS.ErrnoException | undefined)?.code,
              exitCode: result.status,
              stderr: result.stderr
            },
            installationRoot
          ),
          result.error
        )
      return parseWindowsInstallationQuery(result.stdout, installationRoot)
    } catch (cause) {
      logQueryFailure(
        cause instanceof WindowsInstallationQueryError ? cause.diagnostic : cause,
        installationRoot
      )
      try {
        return [
          ...new Set([
            ...knownWindowsResourceUsers(result.stdout ?? ''),
            ...parseWindowsInstallationQuery(
              queryWindowsInstallationDirectSync(installationRoot),
              installationRoot
            )
          ])
        ]
      } catch (fallback) {
        createLogger('update').warn(
          'Independent Windows installation inspection failed',
          fallback instanceof WindowsInstallationQueryError
            ? { stage: fallback.stage, ...fallback.diagnostic }
            : queryDiagnostic(fallback, installationRoot)
        )
        throw new UpdateLifecycleError(
          'installation-busy',
          'Installation process occupancy could not be inspected.',
          undefined,
          {
            cause: new AggregateError(
              [cause, fallback],
              'Both Windows installation inspections failed.'
            )
          }
        )
      }
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
          (isLinuxInstallationExecutable(Number(match[1]), installationRoot) ||
            isLinuxInstallationFileUser(Number(match[1]), installationRoot))))
    )
      pids.add(Number(match[1]))
  }
  if (process.platform === 'darwin') {
    // Inspect ordinary open files as well as executable mappings, including processes whose
    // command line does not mention the installation (for example a loaded helper file).
    const mappings = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-Fpn'], {
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
  try {
    installationRoot = realpathSync(installationRoot) || installationRoot
  } catch {
    /* The installation may already have moved. */
  }
  const { runVerificationProcess } = await import('./verification-process')
  const run = (command: string, args: string[]): ReturnType<typeof runVerificationProcess> =>
    runVerificationProcess(command, args, { signal, timeoutMs: 15_000 })
  if (process.platform === 'win32') {
    let stdout = ''
    try {
      ;({ stdout } = await run('powershell.exe', windowsInstallationQuery(installationRoot)))
      return parseWindowsInstallationQuery(stdout, installationRoot)
    } catch (cause) {
      signal?.throwIfAborted()
      if (!stdout && typeof (cause as { stdout?: unknown })?.stdout === 'string')
        stdout = (cause as { stdout: string }).stdout
      // Cleanup failure is not a query failure: a still-running probe forbids replacement.
      const { VerificationProcessUnsettledError } = await import('./verification-process')
      if (cause instanceof VerificationProcessUnsettledError) throw cause
      logQueryFailure(cause, installationRoot)
      try {
        return [
          ...new Set([
            ...knownWindowsResourceUsers(stdout),
            ...parseWindowsInstallationQuery(
              await queryWindowsInstallationDirect(installationRoot, signal),
              installationRoot
            )
          ])
        ]
      } catch (fallback) {
        signal?.throwIfAborted()
        createLogger('update').warn(
          'Independent Windows installation inspection failed',
          fallback instanceof WindowsInstallationQueryError
            ? { stage: fallback.stage, ...fallback.diagnostic }
            : queryDiagnostic(fallback, installationRoot)
        )
        throw new UpdateLifecycleError(
          'installation-busy',
          'Installation process occupancy could not be inspected.',
          undefined,
          {
            cause: new AggregateError(
              [cause, fallback],
              'Both Windows installation inspections failed.'
            )
          }
        )
      }
    }
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
          (isLinuxInstallationExecutable(Number(match[1]), installationRoot) ||
            isLinuxInstallationFileUser(Number(match[1]), installationRoot))))
    )
      pids.add(Number(match[1]))
  }
  if (process.platform === 'darwin') {
    const maps = await run('/usr/sbin/lsof', ['-n', '-P', '-Fpn'])
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

/** Crashpad is absent from getAppMetrics() and is reparented on macOS/Linux.
 * Accept only the exact bundled executable, crash database and per-launch annotation.
 * A previous launch (even with the same profile), another profile, or an unannotated
 * handler remains an occupant. This is ownership evidence, not a process-name exemption. */
export function inspectOwnedCrashpadProcesses(options: {
  installationRoot: string
  crashDumpsPath: string
  instanceId: string
}): number[] {
  if (process.platform === 'win32') return inspectOwnedWindowsCrashpadProcesses(options)
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
  return [...commands].flatMap(([pid, command]) => {
    if (process.platform === 'linux') {
      try {
        command = readlinkSync(`/proc/${pid}/exe`)
      } catch {
        return []
      }
    }
    if (canonical(command) !== executable) return []
    let args: string[] | null
    try {
      // Startup recovery must remain reachable when the native component is missing or damaged.
      // Load only for macOS inspection; failure grants no ownership exemption and can be retried.
      args =
        process.platform === 'darwin'
          ? (
              requireNative(
                '@aipoch/process-tree-native'
              ) as typeof import('@aipoch/process-tree-native')
            ).getDarwinProcessArguments(pid)
          : readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    } catch {
      return []
    }
    if (!args?.length || canonical(args[0]) !== executable) return []
    const databases = args.filter((arg) => arg.startsWith('--database='))
    const instances = args.filter((arg) => arg.startsWith('--annotation=openScienceInstance='))
    return databases.length === 1 &&
      canonical(databases[0].slice('--database='.length)) === database &&
      instances.length === 1 &&
      instances[0] === `--annotation=openScienceInstance=${options.instanceId}`
      ? [pid]
      : []
  })
}

function inspectOwnedWindowsCrashpadProcesses(options: {
  installationRoot: string
  crashDumpsPath: string
  instanceId: string
}): number[] {
  const canonical = (path: string): string | undefined => {
    try {
      return realpathSync(path).toLowerCase()
    } catch {
      return undefined
    }
  }
  const executable = canonical(process.execPath)
  const database = canonical(options.crashDumpsPath)
  if (
    !executable ||
    !database ||
    !options.instanceId ||
    canonical(dirname(executable)) !== canonical(options.installationRoot)
  )
    return []
  // Parse with Windows' own argv rules: quoted profile paths and annotation values must not be
  // inferred with substring matching. Only current direct children are even considered.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ' +
      process.pid +
      '" | Where-Object { $_.CommandLine -like "*--type=crashpad-handler*" })',
    'if ($rows.Count -eq 0) { Write-Output "[]"; exit 0 }',
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class OpenScienceCrashpadArguments {',
    '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string value, out int count);',
    '  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);',
    '  public static string[] Parse(string value) {',
    '    int count; IntPtr pointer = CommandLineToArgvW(value, out count);',
    '    if (pointer == IntPtr.Zero) throw new InvalidOperationException("Cannot parse process arguments");',
    '    try { string[] result = new string[count]; for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size)); return result; }',
    '    finally { LocalFree(pointer); }',
    '  }',
    '}',
    "'@",
    '$result = @($rows | ForEach-Object { @{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;ExecutablePath=$_.ExecutablePath;Arguments=[OpenScienceCrashpadArguments]::Parse($_.CommandLine)} })',
    'ConvertTo-Json -InputObject $result -Depth 4 -Compress'
  ].join('\n')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024
    }
  )
  try {
    if (result.status !== 0) throw result.error ?? new Error('Process query failed')
    const rows: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(rows)) throw new Error('Invalid process query result')
    return rows.flatMap((row) => {
      if (
        !row ||
        !Number.isSafeInteger(row.ProcessId) ||
        row.ProcessId <= 0 ||
        row.ParentProcessId !== process.pid ||
        typeof row.ExecutablePath !== 'string' ||
        canonical(row.ExecutablePath) !== executable ||
        !Array.isArray(row.Arguments) ||
        !row.Arguments.every((arg: unknown) => typeof arg === 'string')
      )
        return []
      const args: string[] = row.Arguments
      const values = (key: string): string[] =>
        args.filter((arg) => arg.startsWith(key + '=')).map((arg) => arg.slice(key.length + 1))
      const types = values('--type')
      const databases = values('--database')
      const instances = values('--annotation=openScienceInstance')
      return types.length === 1 &&
        types[0] === 'crashpad-handler' &&
        databases.length === 1 &&
        canonical(databases[0]) === database &&
        instances.length === 1 &&
        instances[0] === options.instanceId
        ? [row.ProcessId]
        : []
    })
  } catch (cause) {
    throw new UpdateLifecycleError(
      'installation-busy',
      'Crash reporter ownership could not be inspected.',
      undefined,
      { cause }
    )
  }
}
