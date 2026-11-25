import type { ClientConnection } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { SendAttemptScope } from '../../shared/send-attempt-diagnostics'
import type { harnessCheckpointLockSchema } from '../harness-acp/config'
import { currentSendAttempt, withSendAttempt, writeSendAttempt } from '../send-attempt-diagnostics'

const activeResumes = new WeakMap<ClientConnection, Map<string, SendAttemptScope>>()
const results = {
  waiting: 'started',
  acquired: 'completed',
  'timed-out': 'timed-out',
  failed: 'failed'
} as const

/** 只接受当前 ACP 连接接回的恢复操作 ID，发送身份始终由主进程持有。 */
export async function traceCheckpointLock<Result>(
  connection: ClientConnection,
  resume: (operationId?: string) => Promise<Result>
): Promise<Result> {
  const scope = currentSendAttempt()
  if (!scope) return resume()
  let operations = activeResumes.get(connection)
  if (!operations) {
    operations = new Map()
    activeResumes.set(connection, operations)
  }
  const operationId = randomUUID()
  operations.set(operationId, scope)
  try {
    return await resume(operationId)
  } finally {
    operations.delete(operationId)
  }
}

export function recordCheckpointLock(
  connection: ClientConnection,
  event: z.infer<typeof harnessCheckpointLockSchema>
): void {
  const scope = activeResumes.get(connection)?.get(event.operationId)
  if (!scope) return
  withSendAttempt(scope, scope, () =>
    writeSendAttempt({
      phase: 'checkpoint-lock',
      operationId: event.operationId,
      result: results[event.status],
      timeoutMs: event.timeoutMs,
      ...(event.status === 'waiting' ? {} : { durationMs: event.durationMs })
    })
  )
}
