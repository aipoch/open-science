import { processBirthIdentity } from './process-birth-identity'
import { readServiceLifetime, serviceLifetimeRecordSchema } from './local-service-lifetime'
import { isRuntimeProcessAlive } from './runtime-stop-confirmation'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The target comes from an authenticated bootstrap, never from a PID/name search. */
export async function terminateVerifiedService(target: {
  configRoot: string
  generation: string
  pid: number
  birthToken?: string
  deadlineAt?: number
  signal?: AbortSignal
}): Promise<void> {
  target.signal?.throwIfAborted()
  if (!isRuntimeProcessAlive(target.pid)) return
  if (target.deadlineAt !== undefined && Date.now() >= target.deadlineAt)
    throw new Error('The local service termination deadline expired.')
  let readDeadline: ReturnType<typeof setTimeout> | undefined
  let cancelRead: (() => void) | undefined
  let intent: Awaited<ReturnType<typeof readServiceLifetime>>
  try {
    // Bound the read itself so a timed-out caller cannot leave a continuation that later signals.
    intent = await Promise.race([
      readServiceLifetime(target.configRoot),
      new Promise<never>((_resolve, reject) => {
        cancelRead = () => reject(target.signal?.reason)
        target.signal?.addEventListener('abort', cancelRead, { once: true })
        if (target.signal?.aborted) cancelRead()
        if (target.deadlineAt !== undefined)
          readDeadline = setTimeout(
            () => reject(new Error('The local service termination deadline expired.')),
            Math.max(0, target.deadlineAt - Date.now())
          )
      })
    ])
  } finally {
    clearTimeout(readDeadline)
    if (cancelRead) target.signal?.removeEventListener('abort', cancelRead)
  }
  if (
    !target.birthToken ||
    target.pid === process.pid ||
    intent?.generation !== target.generation ||
    !intent.stopping
  )
    throw new Error('The local service stop identity or intent could not be verified.')
  const signal = (mode: NodeJS.Signals): void => {
    // Final disk authorization cannot use a stale inode result delivered after an await. The
    // service also irreversibly retires this generation once a stop grant may have published.
    const currentIntent = serviceLifetimeRecordSchema.parse(
      JSON.parse(readFileSync(join(target.configRoot, 'service-lifetime.json'), 'utf8'))
    )
    if (currentIntent?.generation !== target.generation || !currentIntent.stopping)
      throw new Error('The local service stop intent changed before termination.')
    if (target.deadlineAt !== undefined && Date.now() >= target.deadlineAt)
      throw new Error('The local service termination deadline expired.')
    target.signal?.throwIfAborted()
    if (processBirthIdentity(target.pid) !== target.birthToken)
      throw new Error('The local service process identity changed before termination.')
    process.kill(target.pid, mode)
  }
  signal('SIGTERM')
  const deadline = Math.min(Date.now() + 500, (target.deadlineAt ?? Infinity) - 3000)
  while (Date.now() < deadline && isRuntimeProcessAlive(target.pid)) {
    target.signal?.throwIfAborted()
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (isRuntimeProcessAlive(target.pid)) signal('SIGKILL')
}
