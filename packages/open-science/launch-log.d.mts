import type { Writable, Duplex } from 'node:stream'
import type { Socket } from 'node:net'
export function startLaunchLogReader(
  node: string,
  fileDescriptor: number,
  serviceLauncher?: string
): Promise<{
  input: Writable
  control: Duplex
  closed: Promise<number | null>
}>

export function bindLaunchLogReader(options: {
  entryPath: string
  bootstrapPath: string
}): Promise<Socket | undefined>
