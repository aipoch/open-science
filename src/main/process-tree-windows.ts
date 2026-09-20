import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { win32 } from 'node:path'

import type { AgentProcessSpawner } from './agent-framework/types'

type Binding = typeof import('@aipoch/process-tree-native')
const nativeProcesses = new WeakMap<ChildProcess, object>()
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
