import type { Writable, Duplex } from 'node:stream'
import type { Socket } from 'node:net'
export function startLaunchLogReader(
  node: string,
  fileDescriptor: number,
  options: { entryPath: string; packaged: boolean; serviceLauncher?: string }
): Promise<{
  input: Writable
  control: Duplex
  closed: Promise<number | null>
}>

export function bindLaunchLogReader(): Promise<Socket | undefined>
export function restartWithLaunchLogReader(
  control?: Socket
): import('node:child_process').ChildProcess
