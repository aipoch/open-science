import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep, win32 } from 'node:path'
import { UpdateLifecycleError } from '../../shared/update'
import { createLogger, runtimeChildProcessErrorFields } from '@aipoch/diagnostics/node'
import {
  listWindowsProcesses,
  splitWindowsCommandLine,
  windowsParentProcessId,
  windowsProcessCommandLine
} from '../windows-process-query'

const requireNative = createRequire(__filename)

function windowsInstallationOccupants(resourcePids: readonly number[], root: string): number[] {
  const pids = new Set<number>()
  for (const pid of resourcePids) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid installation resource PID.')
    pids.add(pid)
  }
  root = root.toLowerCase().replace(/[\\/]+$/, '')
  for (const row of listWindowsProcesses()) {
    const path = row.executablePath?.toLowerCase() ?? ''
    if (path === root || path.startsWith(root + '\\') || path.startsWith(root + '/')) {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0)
        throw new Error('Invalid installation executable PID.')
      pids.add(row.pid)
    }
  }
  return [...pids]
}

function windowsInspectionFailure(cause: unknown): UpdateLifecycleError {
  return new UpdateLifecycleError(
    'installation-busy',
    'Installation process occupancy could not be inspected.',
    undefined,
    { cause }
  )
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

function isLinuxInstallationMappingUser(pid: number, root: string): boolean {
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
  // This helper runs only after argv/exe yielded no installation candidate. An unrelated user's
  // protected process cannot make every ordinary Linux update permanently unavailable. Record
  // the coverage limitation rather than claim whole-machine absence of mapping users. A registered
  // or path-matched installation candidate remains an occupant in the caller regardless of this
  // optional supplement. Complete cross-user evidence is still a platform acceptance gap.
  if (unknown && ['EACCES', 'EPERM'].includes((unknown as NodeJS.ErrnoException).code ?? '')) {
    createLogger('update').warn('Linux installation mapping scan coverage limited', {
      pid,
      code: (unknown as NodeJS.ErrnoException).code
    })
  } else if (unknown)
    throw new UpdateLifecycleError(
      'installation-busy',
      `Installation mapping use could not be verified for process ${pid}. Retry the occupancy check or cancel this update.`,
      undefined,
      { cause: unknown }
    )
  return false
}

// On macOS only the executable path is evidence. A shell or file picker may mention
// the bundle in its arguments without loading anything from it.
function installationPsArgs(): string[] {
  return ['-axo', process.platform === 'darwin' ? 'pid=,comm=' : 'pid=,command=']
}

function installationPsOccupants(
  stdout: string,
  installationRoot: string,
  signal?: AbortSignal
): Set<number> {
  const pids = new Set<number>()
  for (const line of stdout.split('\n')) {
    signal?.throwIfAborted()
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const [, pid, command] = match
    if (process.platform === 'darwin') {
      if (command === installationRoot || command.startsWith(installationRoot + '/'))
        pids.add(Number(pid))
    } else if (
      command.includes(installationRoot) ||
      (process.platform === 'linux' &&
        (isLinuxInstallationExecutable(Number(pid), installationRoot) ||
          isLinuxInstallationMappingUser(Number(pid), installationRoot)))
    )
      pids.add(Number(pid))
  }
  return pids
}

// Detect pre-registration runtimes as well as current protocol participants. Process-list failure is
// unknown occupancy, never an empty list. The caller excludes only its own Desktop and exact Runtime.
export function inspectInstallationProcesses(installationRoot: string): number[] {
  try {
    installationRoot = realpathSync(installationRoot) || installationRoot
  } catch {
    /* The installation may already have moved. */
  }
  if (process.platform === 'win32')
    // A cold Restart Manager scan can take 70 seconds, so it is never run on this thread.
    // Windows callers use inspectInstallationProcessesAsync, which bounds it in a worker process.
    throw windowsInspectionFailure(
      new Error('Windows installation occupancy requires the bounded asynchronous scanner.')
    )
  const result = spawnSync('/bin/ps', installationPsArgs(), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0)
    throw new UpdateLifecycleError(
      'installation-busy',
      'Installation process occupancy could not be inspected.'
    )
  const pids = installationPsOccupants(result.stdout, installationRoot)
  if (process.platform === 'darwin') {
    // Inspect executable and mapped files (dylib, asar mmap), not ordinary open descriptors.
    // Only `txt` mappings can block a rename replacement or survive it.
    const mappings = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-Fpfn'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    if (mappings.status !== 0)
      throw new UpdateLifecycleError(
        'installation-busy',
        'Mapped installation files could not be inspected.'
      )
    for (const pid of parseDarwinLsofMappings(mappings.stdout, installationRoot)) pids.add(pid)
  }
  return [...pids]
}

function parseDarwinLsofMappings(lsofOutput: string, installationRoot: string): number[] {
  const pids: number[] = []
  let pid = 0
  let isTextMapping = false
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      isTextMapping = false
    } else if (line.startsWith('f')) {
      isTextMapping = line === 'ftxt'
    } else if (
      line.startsWith('n') &&
      isTextMapping &&
      (line.slice(1) === installationRoot || line.slice(1).startsWith(`${installationRoot}/`))
    ) {
      pids.push(pid)
      isTextMapping = false
    }
  }
  return pids
}

export async function inspectInstallationProcessesAsync(
  installationRoot: string,
  signal?: AbortSignal
): Promise<number[]> {
  signal?.throwIfAborted()
  const { runVerificationProcess } = await import('./verification-process')
  const run = (command: string, args: string[]): ReturnType<typeof runVerificationProcess> =>
    runVerificationProcess(command, args, { signal, timeoutMs: 15_000 })
  if (process.platform === 'win32') {
    // Query the actual files as Restart Manager resources. This is read-only: no RmShutdown,
    // process-name matching, or termination authority is granted by the returned PIDs.
    // https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
    // A cold Restart Manager scan can take 70 seconds. Keep enumeration and the native call in
    // an owned process: abort/timeout must reap the scan, not just abandon a libuv work item.
    const started = Date.now()
    try {
      // Load the unpacked Node-API binary directly: plain Node cannot resolve an ASAR archive.
      const nativePath = requireNative
        .resolve('@aipoch/process-tree-native/build/Release/process_tree_native.node')
        .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
      const { stdout } = await runVerificationProcess(
        process.execPath,
        [
          '-e',
          String.raw`
          const fs = require('node:fs')
          const { join } = require('node:path')
          const native = require(process.argv[1])
          let root = process.argv[2]
          try { root = fs.realpathSync(root) } catch { /* The installation may have moved. */ }
          const files = []
          if (!fs.statSync(root).isDirectory()) files.push(root)
          else {
            // Node's recursive readdir stats every non-directory, including known regular files.
            // Reuse Dirent types while retaining its directory-link traversal and file-link exclusion.
            // Keep physical ASAR archives as resources; Electron recursive readdir expands virtual entries.
            const directories = [root]
            const visited = new Set()
            for (let index = 0; index < directories.length; index++) {
              // Canonical paths stop self/ancestor junction cycles without dropping distinct targets.
              // Resolution failures remain unknown occupancy, not proof that a directory is empty.
              const canonical = fs.realpathSync.native(directories[index])
              if (visited.has(canonical)) continue
              visited.add(canonical)
              for (const entry of fs.readdirSync(directories[index], { withFileTypes: true })) {
                const file = join(entry.parentPath, entry.name)
                if (entry.isFile()) files.push(file)
                else if (entry.isDirectory()) directories.push(file)
                else {
                  // Match recursive readdir's best-effort directory probe for other entry types.
                  try { if (fs.statSync(file).isDirectory()) directories.push(file) } catch {}
                }
              }
            }
          }
          // Only this short-lived scanner is exempt; the parent and other occupants remain.
          const pids = native.listWindowsInstallationOccupants(files).filter(pid => pid !== process.pid)
          process.stdout.write(JSON.stringify({ root, pids }))
        `,
          nativePath,
          installationRoot
        ],
        { signal, timeoutMs: 120_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
      signal?.throwIfAborted()
      const result: unknown = JSON.parse(stdout)
      if (
        !result ||
        typeof result !== 'object' ||
        !('root' in result) ||
        typeof result.root !== 'string' ||
        !('pids' in result) ||
        !Array.isArray(result.pids)
      )
        throw new Error('Invalid installation resource scan result.')
      return windowsInstallationOccupants(result.pids, result.root)
    } catch (cause) {
      if (signal?.aborted) throw cause
      createLogger('update').warn('Windows installation occupancy inspection failed', {
        ...runtimeChildProcessErrorFields(cause),
        durationMs: Date.now() - started,
        message: cause instanceof Error ? cause.message : 'Unknown inspection error'
      })
      throw windowsInspectionFailure(cause)
    }
  }
  try {
    installationRoot = realpathSync(installationRoot) || installationRoot
  } catch {
    /* The installation may already have moved. */
  }
  const { stdout } = await run('/bin/ps', installationPsArgs())
  const pids = installationPsOccupants(stdout, installationRoot, signal)
  if (process.platform === 'darwin') {
    const maps = await run('/usr/sbin/lsof', ['-n', '-P', '-Fpfn'])
    for (const pid of parseDarwinLsofMappings(maps.stdout, installationRoot)) pids.add(pid)
  }
  return [...pids]
}

// macOS `ps -o comm=` prints the full executable path; show the executable name only.
export function parseDarwinProcessNames(psOutput: string): Map<number, string> {
  const names = new Map<number, string>()
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    const name = match?.[2].trim().split('/').pop()
    if (match && name) names.set(Number(match[1]), name)
  }
  return names
}

/** Synchronous process name lookup for diagnostics only; macOS uses the async variant. */
export function inspectProcessNames(pids: number[]): Map<number, string> {
  const names = new Map<number, string>()
  if (pids.length === 0) return names
  if (process.platform === 'win32') {
    try {
      const wanted = new Set(pids)
      for (const row of listWindowsProcesses()) {
        if (!wanted.has(row.pid) || !row.executablePath) continue
        const name = win32.basename(row.executablePath)
        if (name) names.set(row.pid, name)
      }
    } catch {
      // Process names are diagnostic only; an unavailable snapshot must not change occupancy.
    }
    return names
  }
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
        if (comm) names.set(pid, comm)
      } catch {
        // Process exited or inaccessible; diagnostic only, no occupancy impact.
      }
    }
  }
  return names
}

/** Best-effort asynchronous process name lookup for update diagnostics. */
export async function inspectProcessNamesAsync(
  pids: number[],
  signal?: AbortSignal
): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  if (pids.length === 0) return names
  if (process.platform !== 'darwin') return inspectProcessNames(pids)
  try {
    const { runVerificationProcess } = await import('./verification-process')
    const { stdout } = await runVerificationProcess(
      '/bin/ps',
      ['-o', 'pid=,comm=', '-p', pids.join(',')],
      { signal, timeoutMs: 5_000, maxBytes: 1024 * 1024 }
    )
    for (const [pid, name] of parseDarwinProcessNames(stdout)) names.set(pid, name)
  } catch {
    signal?.throwIfAborted()
  }
  return names
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
  try {
    return listWindowsProcesses().flatMap((row) => {
      if (row.ppid !== process.pid || row.pid <= 0 || !Number.isSafeInteger(row.pid)) return []
      if (!row.executablePath || canonical(row.executablePath) !== executable) return []
      const commandLine = windowsProcessCommandLine(row.pid)
      if (!commandLine?.includes('--type=crashpad-handler')) return []
      const args = splitWindowsCommandLine(commandLine)
      const values = (key: string): string[] =>
        args.filter((arg) => arg.startsWith(key + '=')).map((arg) => arg.slice(key.length + 1))
      const types = values('--type')
      const databases = values('--database')
      const instances = values('--annotation=openScienceInstance')
      // Re-read the parent so a PID reused after the snapshot cannot borrow this exemption.
      return types.length === 1 &&
        types[0] === 'crashpad-handler' &&
        databases.length === 1 &&
        canonical(databases[0]) === database &&
        instances.length === 1 &&
        instances[0] === options.instanceId &&
        windowsParentProcessId(row.pid) === process.pid
        ? [row.pid]
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
