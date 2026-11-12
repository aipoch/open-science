import type { Writable } from 'node:stream'
export function startLaunchLogReader(
  node: string,
  fileDescriptor: number,
  serviceLauncher?: string
): Promise<{
  input: Writable
  closed: Promise<number | null>
}>
