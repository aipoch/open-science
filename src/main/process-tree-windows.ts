import { ChildProcess, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { win32 } from 'node:path'

import type { AgentProcessSpawner } from './node-process-host'
import { resolveWindowsPowerShellExecutable } from './windows-powershell'

type Binding = typeof import('@aipoch/process-tree-native')
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
  const jobs: string[] = []
  for (const [name, reference] of activeJobs) {
    // deref keeps the exclusive native Job alive for this synchronous query. An expired handle
    // grants no exemption; names/PIDs from another process or a persisted file are never accepted.
    if (reference.deref()) jobs.push(name)
    else activeJobs.delete(name)
  }
  if (jobs.length === 0) return []
  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Runtime.InteropServices;
public static class OpenScienceOwnedJobs {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint size, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Members(string name) {
    IntPtr job = OpenJobObject(4, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      for (int capacity = 64; capacity <= 65536; capacity *= 2) {
        int size = 8 + capacity * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          if (!QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 234) continue;
            throw new Win32Exception(error);
          }
          int assigned = Marshal.ReadInt32(buffer), count = Marshal.ReadInt32(buffer, 4);
          if (count < assigned) continue;
          if (count < 0 || count > capacity) throw new InvalidOperationException("Invalid Job process count");
          int[] pids = new int[count];
          for (int i = 0; i < count; i++) pids[i] = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
          return pids;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Owned Job process list remained incomplete");
    } finally { CloseHandle(job); }
  }
}
'@
$names = [Console]::In.ReadToEnd() | ConvertFrom-Json
$pids = @($names | ForEach-Object { [OpenScienceOwnedJobs]::Members($_) })
ConvertTo-Json -InputObject $pids -Compress
`
    ],
    {
      input: JSON.stringify(jobs),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    }
  )
  if (result.status !== 0)
    throw new Error('Owned Windows process inspection failed.', {
      cause: result.error ?? result.stderr
    })
  const pids: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error('Owned Windows process inspection returned invalid identities.')
  return [...new Set(pids as number[])]
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
  const poll = setInterval(() => {
    const code = native.windowsOwnedProcessExitCode(launched.handle)
    if (code === null) return
    clearInterval(poll)
    Object.assign(child, { exitCode: code })
    exited = true
    child.stdin.destroy()
    child.emit('exit', code, null)
    maybeClose()
  }, 25)
  child.unref = () => {
    poll.unref()
    streams.forEach((stream) => stream.unref())
  }
  child.ref = () => {
    poll.ref()
    streams.forEach((stream) => stream.ref())
  }
  queueMicrotask(() => child.emit('spawn'))
  return child
}
