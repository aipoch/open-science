import { execFile } from 'node:child_process'
import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'

type KernelExit = { pid?: number; signal: string | null; platform: NodeJS.Platform }
type ExitCause = NonNullable<NotebookExecutionRecovery['kernel']>['cause']

// Read only the short window around this exit, with a strict time/output budget. No log text is
// persisted or shown: the only result is a classification backed by an exact process kill record.
const readMemoryKillLog = (pid: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/log',
      [
        'show',
        '--last',
        '10s',
        '--style',
        'compact',
        '--predicate',
        `process == "kernel" AND eventMessage CONTAINS "memorystatus:" AND eventMessage CONTAINS "[${pid}]"`
      ],
      { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })

export const diagnoseKernelExit = async (
  exit: KernelExit,
  read: (pid: number) => Promise<string> = readMemoryKillLog
): Promise<ExitCause> => {
  if (exit.platform !== 'darwin' || exit.signal !== 'SIGKILL' || !exit.pid) return 'unknown'
  try {
    const output = await read(exit.pid)
    return new RegExp(`memorystatus: killing[^\\n]*\\[${exit.pid}\\]`).test(output)
      ? 'os-memory-pressure'
      : 'unknown'
  } catch {
    // Missing permissions, unavailable records and a timeout are absence of evidence, not OOM.
    return 'unknown'
  }
}
