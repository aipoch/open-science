/* c8 ignore file */
import { ChildProcess, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

import type { AgentProcessSpawner } from './node-process-host'

type Binding = typeof import('@aipoch/process-tree-native')
const run = promisify(execFile)
const nativeProcesses = new WeakMap<ChildProcess, object>()
const activeJobs = new Map<string, WeakRef<object>>()
const binding = (): Binding => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native Node-API binding.
  const native = require('@aipoch/process-tree-native') as Binding
  if (typeof native.spawnWindowsOwnedProcess !== 'function') {
    throw new Error('Windows delegated process ownership is unavailable; no command was started.')
  }
  return native
}

export const reapWindowsOwnedJob = async (jobName: string): Promise<boolean> => {
  const native = binding()
  const deadline = Date.now() + 4_000
  do {
    if (native.reapWindowsOwnedJob(jobName)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  return false
}

/** Admission only: these processes must still be reaped before installation handoff. */
export const inspectOwnedWindowsProcessIds = (): number[] => {
  if (process.platform !== 'win32') return []
  const pids = new Set<number>()
  for (const [name, reference] of activeJobs) {
    // Only a live exclusive native Job grants admission; persisted names/PIDs never do.
    const handle = reference.deref()
    if (!handle) {
      activeJobs.delete(name)
      continue
    }
    const members = binding().windowsOwnedJobProcessIds(handle)
    if (!Array.isArray(members) || members.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
      throw new Error('Owned Windows process inspection returned invalid identities.')
    for (const pid of members) pids.add(pid)
  }
  return [...pids]
}

// Notebook hosts use their own supervisor Jobs. Include only their live, birth-checked ancestry
// rooted in this backend, alongside Agent Job members that may outlive their original leader.
// Synchronous: a cancel frame cannot interrupt it, so only a request already cancelled is skipped.
export const inspectRuntimeWindowsProcessIds = (signal?: AbortSignal): number[] => {
  if (process.platform !== 'win32') return []
  signal?.throwIfAborted()
  return [
    ...new Set([
      ...inspectOwnedWindowsProcessIds(),
      ...binding().windowsCurrentProcessDescendants()
    ])
  ]
}

/** Caller must already own these identities. Never signal a PID after releasing its checked handle. */
export const terminateWindowsProcessesByIdentity = async (
  processes: ReadonlyMap<number, string>,
  deadlineAt: number
): Promise<void> => {
  if (!processes.size) return
  if (Date.now() >= deadlineAt) throw new Error('Update process cleanup deadline expired.')
  const systemRoot = process.env.SystemRoot || process.env.WINDIR
  if (!systemRoot) throw new Error('The Windows system directory is unavailable.')
  // .NET Framework Process.Handle retains the same handle used by StartTime and Kill. Querying
  // birth in Node and then calling taskkill/process.kill would reopen a possibly reused PID.
  const script = `
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($target in $request.processes) {
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $request.deadlineAt) { exit 1 }
  $owned = $null
  try {
    $owned = [Diagnostics.Process]::GetProcessById([int]$target.pid)
    $null = $owned.Handle
    if (!$owned.HasExited -and $owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq $target.birth) {
      if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $request.deadlineAt) { exit 1 }
      $owned.Kill()
    }
  } catch {
    # Missing, reused and inaccessible targets never authorize a broader kill. Node confirms exit.
  } finally {
    if ($null -ne $owned) { $owned.Dispose() }
  }
}`
  const execution = run(
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { timeout: Math.max(1, deadlineAt - Date.now()), windowsHide: true }
  )
  execution.child.stdin?.on('error', () => {}) // Launch/timeout errors are reported by execution.
  execution.child.stdin?.end(
    JSON.stringify({
      deadlineAt,
      processes: [...processes].map(([pid, birth]) => ({ pid, birth }))
    })
  )
  await execution
}

/** Retain ownership before normal teardown can orphan helpers; used only for an authorized update. */
export const captureRuntimeWindowsProcessCleanup = (): ((deadlineAt: number) => Promise<void>) => {
  if (process.platform !== 'win32') return async () => {}
  const native = binding()
  const jobs = new Map<string, object>()
  const processes = new Map<number, string>()
  const members = (): Set<number> => {
    for (const [name, reference] of activeJobs) {
      const handle = reference.deref()
      if (handle) jobs.set(name, handle)
    }
    return new Set([
      ...native.windowsCurrentProcessDescendants(),
      ...[...jobs.values()].flatMap((handle) => native.windowsOwnedJobProcessIds(handle))
    ])
  }
  const capture = (): void => {
    const candidates = new Map<number, string>()
    for (const pid of members()) {
      if (pid === process.pid) continue
      const birth = native.getWindowsProcessCreationTime(pid)
      if (birth) candidates.set(pid, birth)
    }
    // A PID returned by discovery may already have been reused. Bracket membership with birth reads.
    const current = members()
    for (const [pid, birth] of candidates) {
      if (current.has(pid) && native.getWindowsProcessCreationTime(pid) === birth)
        processes.set(pid, birth)
    }
  }
  capture()
  return async (deadlineAt) => {
    // Include children created while the normal disposers were finishing.
    capture()
    for (const name of jobs.keys()) {
      if (Date.now() >= deadlineAt) throw new Error('Update process cleanup deadline expired.')
      // The retained handle keeps this exact named Job alive; never reopen a bare persisted name.
      native.reapWindowsOwnedJob(name)
    }
    const remaining = new Map<number, string>()
    for (const [pid, birth] of processes) {
      try {
        if (native.getWindowsProcessCreationTime(pid) === birth) remaining.set(pid, birth)
      } catch {
        // Continue cleaning other owned processes; the confirmation loop remains authoritative.
      }
    }
    await terminateWindowsProcessesByIdentity(remaining, deadlineAt)
    do {
      let released = true
      for (const [pid, birth] of processes) {
        try {
          if (native.getWindowsProcessCreationTime(pid) === birth) released = false
        } catch {
          released = false
        }
      }
      for (const handle of jobs.values()) {
        try {
          if (native.windowsOwnedJobProcessIds(handle).length) released = false
        } catch {
          released = false
        }
      }
      if (released) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadlineAt)
    throw new Error('Owned update processes did not exit before the cleanup deadline.')
  }
}

// Keep the normal ACP ChildProcess/stream boundary. Overlapped native pipe descriptors use libuv's
// pipe transport via net.Socket, not blocking fs reads that could exhaust the worker pool.
export const spawnWindowsOwnedProcess = (
  jobName: string,
  command: string,
  args: readonly string[],
  options: Parameters<AgentProcessSpawner>[2]
): ChildProcessWithoutNullStreams => {
  const native = binding()
  const env = options.env ?? process.env
  const envValue = (name: string): string | undefined =>
    Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]
  let executable = command
  let argv = [...args]
  let verbatim = false
  if (options.shell) {
    executable =
      typeof options.shell === 'string' ? options.shell : (envValue('COMSPEC') ?? 'cmd.exe')
    argv = ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`]
    verbatim = true
  }
  const cwd = options.cwd === undefined ? process.cwd() : String(options.cwd)
  if (!win32.isAbsolute(executable)) {
    const candidates = [cwd, ...(envValue('PATH') ?? '').split(';')].flatMap((directory) => [
      win32.resolve(directory, executable),
      win32.resolve(directory, `${executable}.exe`)
    ])
    const resolved = candidates.find(existsSync)
    if (!resolved) throw new Error('Delegated executable could not be resolved.')
    executable = resolved
  }
  const environment: string[] = []
  const keys = new Set<string>()
  for (const key of Object.keys(env).sort()) {
    const value = env[key]
    if (value === undefined || keys.has(key.toUpperCase())) continue
    if (key.includes('\0') || value.includes('\0')) throw new Error('Invalid process environment.')
    keys.add(key.toUpperCase())
    environment.push(`${key}=${value}`)
  }
  const launched = native.spawnWindowsOwnedProcess(
    jobName,
    executable,
    argv,
    environment,
    cwd,
    verbatim
  )
  const child = new ChildProcess() as ChildProcessWithoutNullStreams
  nativeProcesses.set(child, launched.handle)
  activeJobs.set(jobName, new WeakRef(launched.handle))
  const streams: Socket[] = []
  try {
    for (const [index, fd] of launched.fds.entries()) {
      streams.push(new Socket({ fd, readable: index !== 0, writable: index === 0 }))
    }
  } catch (error) {
    for (const stream of streams) stream.destroy()
    for (const fd of launched.fds.slice(streams.length)) closeSync(fd)
    void reapWindowsOwnedJob(jobName)
    throw error
  }
  Object.assign(child, {
    pid: launched.pid,
    spawnfile: executable,
    spawnargs: [executable, ...argv],
    stdin: streams[0],
    stdout: streams[1],
    stderr: streams[2],
    stdio: streams
  })
  let exited = false
  let closedStreams = 0
  const maybeClose = (): void => {
    if (exited && closedStreams === 3) child.emit('close', child.exitCode, child.signalCode)
  }
  for (const stream of streams) {
    stream.once('close', () => {
      closedStreams++
      maybeClose()
    })
    stream.on('error', (error) => child.emit('error', error))
  }
  child.kill = () => {
    native.reapWindowsOwnedJob(jobName)
    Object.assign(child, { killed: true })
    return true
  }
  let fallbackPoll: NodeJS.Timeout | undefined
  const pollForExit = (): Promise<number> =>
    new Promise((resolve) => {
      fallbackPoll = setInterval(() => {
        const code = native.windowsOwnedProcessExitCode(launched.handle)
        if (code === null) return
        clearInterval(fallbackPoll)
        fallbackPoll = undefined
        resolve(code)
      }, 25)
      if (!referenced) fallbackPoll.unref()
    })
  const waitForExit = (): Promise<number> => {
    if (typeof native.windowsOwnedProcessExitCodeAsync !== 'function') return pollForExit()
    try {
      return native.windowsOwnedProcessExitCodeAsync(launched.handle).catch(() => pollForExit())
    } catch {
      return pollForExit()
    }
  }
  let referenced = true
  void waitForExit().then(
    (code) => {
      Object.assign(child, { exitCode: code })
      exited = true
      child.stdin.destroy()
      child.emit('exit', code, null)
      maybeClose()
    },
    (error: unknown) => child.emit('error', error)
  )
  child.unref = () => {
    if (!referenced) return
    referenced = false
    native.windowsOwnedProcessExitCodeUnref?.(launched.handle)
    fallbackPoll?.unref()
    streams.forEach((stream) => stream.unref())
  }
  child.ref = () => {
    if (referenced) return
    referenced = true
    native.windowsOwnedProcessExitCodeRef?.(launched.handle)
    fallbackPoll?.ref()
    streams.forEach((stream) => stream.ref())
  }
  queueMicrotask(() => child.emit('spawn'))
  return child
}
