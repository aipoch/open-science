import { createLogger } from '@aipoch/diagnostics/node'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  acquireRuntimeDirectorySync,
  RuntimeOwnershipConflict,
  type RuntimeDirectoryLease
} from './runtime-ownership'

const exitSchema = z
  .object({
    generation: z.string().uuid(),
    pid: z.number().int().positive(),
    outcome: z.enum(['clean', 'failed'])
  })
  .strict()
export function isRuntimeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}
export type RuntimeStopEvidence = {
  processExited: boolean
  lockHeld: boolean
  exitRecord: 'unchecked' | 'missing' | 'invalid' | 'failed' | 'clean'
}
export class RuntimeStopError extends Error {
  constructor(
    readonly code: 'runtime-stop-timeout' | 'runtime-stop-unclean',
    readonly evidence: RuntimeStopEvidence
  ) {
    super(
      code === 'runtime-stop-timeout'
        ? 'Runtime shutdown could not be confirmed within the stop deadline.'
        : 'Runtime did not leave a matching clean exit record.'
    )
  }
}
export async function writeRuntimeExit(
  configRoot: string,
  record: z.infer<typeof exitSchema>
): Promise<void> {
  const path = join(configRoot, 'runtime-exit.json')
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(exitSchema.parse(record)), { mode: 0o600, flag: 'wx' })
  await rename(temp, path)
}
export async function readRuntimeExitOutcome(
  configRoot: string,
  generation: string,
  pid: number
): Promise<'clean' | 'failed' | 'unknown'> {
  try {
    const record = exitSchema.parse(
      JSON.parse(await readFile(join(configRoot, 'runtime-exit.json'), 'utf8'))
    )
    return record.generation === generation && record.pid === pid ? record.outcome : 'unknown'
  } catch {
    return 'unknown'
  }
}
export async function waitForRuntimeStopped(options: {
  configRoot: string
  generation: string
  pid: number
  socketClosed?: () => boolean
  requireCleanExit?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<RuntimeDirectoryLease> {
  const started = Date.now()
  const logger = createLogger('desktop-runtime-client')
  logger.info('runtime-stop', {
    step: 'confirm',
    generation: options.generation,
    runtimePid: options.pid
  })
  const deadline = started + (options.timeoutMs ?? 15_000)
  const evidence: RuntimeStopEvidence = {
    processExited: false,
    lockHeld: false,
    exitRecord: 'unchecked'
  }
  let lease: RuntimeDirectoryLease | undefined
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    evidence.processExited = !isRuntimeProcessAlive(options.pid)
    if (evidence.processExited && (options.socketClosed?.() ?? true)) {
      try {
        lease = acquireRuntimeDirectorySync(options.configRoot)
        break
      } catch (error) {
        if (!(error instanceof RuntimeOwnershipConflict)) throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!lease) {
    logger.warn('runtime-stop', {
      step: 'confirm',
      elapsedMs: Date.now() - started,
      result: 'runtime-stop-timeout',
      ...evidence
    })
    throw new RuntimeStopError('runtime-stop-timeout', evidence)
  }
  evidence.lockHeld = true
  if (options.requireCleanExit === false) return lease
  try {
    let record: z.infer<typeof exitSchema> | undefined
    try {
      record = exitSchema.parse(
        JSON.parse(await readFile(join(options.configRoot, 'runtime-exit.json'), 'utf8'))
      )
    } catch (error) {
      evidence.exitRecord =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'
    }
    if (record)
      evidence.exitRecord =
        record.generation !== options.generation || record.pid !== options.pid
          ? 'invalid'
          : record.outcome
    if (evidence.exitRecord !== 'clean')
      throw new RuntimeStopError('runtime-stop-unclean', evidence)
    logger.info('runtime-stop', {
      step: 'confirmed',
      elapsedMs: Date.now() - started,
      result: 'clean',
      ...evidence
    })
    return lease
  } catch (error) {
    lease.release()
    evidence.lockHeld = false
    logger.warn('runtime-stop', {
      step: 'exit-record',
      elapsedMs: Date.now() - started,
      result: 'runtime-stop-unclean',
      ...evidence
    })
    throw error
  }
}
