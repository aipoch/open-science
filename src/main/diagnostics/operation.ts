import { randomUUID } from 'node:crypto'

import { diagnosticErrorFields, type Logger } from '../logger'
import { classifyStartupDelay } from './startup-delay'

export type DiagnosticValue = string | number | boolean | null | undefined
export type DiagnosticFields = Record<string, DiagnosticValue>
export type DiagnosticCpuUsage = Readonly<{ system: number; user: number }>

export type DiagnosticOperation = {
  phase: (name: string, fields?: DiagnosticFields) => void
  complete: (fields?: DiagnosticFields) => void
  cancel: (fields?: DiagnosticFields) => void
  fail: (error: unknown, fields?: DiagnosticFields) => void
}

export type DiagnosticOperationInput = {
  operation: string
  fields?: DiagnosticFields
  now?: () => number
  cpuUsage?: () => DiagnosticCpuUsage
  operationId?: string
}

const scalarFields = (fields: DiagnosticFields | undefined): DiagnosticFields => {
  try {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}

    const safe: DiagnosticFields = Object.create(null) as DiagnosticFields
    for (const key of Object.keys(fields)) {
      let value: unknown
      try {
        value = (fields as Record<string, unknown>)[key]
      } catch {
        continue
      }
      if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        safe[key] = value as DiagnosticValue
      }
    }
    return safe
  } catch {
    return {}
  }
}

let fallbackOperationId = 0

const inputValue = (
  input: DiagnosticOperationInput,
  key: keyof DiagnosticOperationInput
): unknown => {
  try {
    return input[key]
  } catch {
    return undefined
  }
}

const createOperationId = (): string => {
  try {
    return randomUUID()
  } catch {
    fallbackOperationId += 1
    return `diagnostic-${fallbackOperationId}`
  }
}

const emitSafely = (
  logger: Logger,
  level: keyof Logger,
  message: string,
  data: Record<string, unknown>
): void => {
  try {
    logger[level](message, data)
  } catch {
    // Diagnostics must never alter the authoritative operation.
  }
}

export const startDiagnosticOperation = (
  logger: Logger,
  input: DiagnosticOperationInput
): DiagnosticOperation => {
  const rawOperation = inputValue(input, 'operation')
  const operation = typeof rawOperation === 'string' && rawOperation ? rawOperation : 'unknown'
  const rawOperationId = inputValue(input, 'operationId')
  const operationId =
    typeof rawOperationId === 'string' && rawOperationId ? rawOperationId : createOperationId()
  const rawNow = inputValue(input, 'now')
  const now = typeof rawNow === 'function' ? (rawNow as () => number) : Date.now
  const readNow = (): number => {
    try {
      const value = now()
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
  const startedAt = readNow()
  const rawCpuUsage = inputValue(input, 'cpuUsage')
  const readCpuUsage =
    typeof rawCpuUsage === 'function'
      ? (): DiagnosticCpuUsage | undefined => {
          try {
            const usage = (rawCpuUsage as () => DiagnosticCpuUsage)()
            return Number.isFinite(usage?.user) && Number.isFinite(usage?.system)
              ? usage
              : undefined
          } catch {
            return undefined
          }
        }
      : undefined
  const startedCpuUsage = readCpuUsage?.()
  let phaseCpuUsage = startedCpuUsage
  const baseFields = scalarFields(inputValue(input, 'fields') as DiagnosticFields | undefined)
  let latestPhase: string | undefined
  let phaseStartedAt = startedAt
  let terminal = false

  const eventFields = (fields?: DiagnosticFields): Record<string, unknown> => ({
    ...baseFields,
    ...scalarFields(fields),
    operation,
    operationId
  })
  const cpuFields = (cpuIntervalPhase: string): Record<string, unknown> => {
    if (!startedCpuUsage || !phaseCpuUsage || !readCpuUsage) return {}
    const current = readCpuUsage()
    if (!current) return {}
    const cpuUserMs = Math.max(0, current.user - startedCpuUsage.user) / 1_000
    const cpuSystemMs = Math.max(0, current.system - startedCpuUsage.system) / 1_000
    const phaseCpuUserMs = Math.max(0, current.user - phaseCpuUsage.user) / 1_000
    const phaseCpuSystemMs = Math.max(0, current.system - phaseCpuUsage.system) / 1_000
    phaseCpuUsage = current
    return {
      cpuIntervalPhase,
      cpuUserMs,
      cpuSystemMs,
      cpuTotalMs: cpuUserMs + cpuSystemMs,
      phaseCpuUserMs,
      phaseCpuSystemMs,
      phaseCpuTotalMs: phaseCpuUserMs + phaseCpuSystemMs
    }
  }
  const delayFields = (
    durationMs: number,
    cpu: Record<string, unknown>
  ): Record<string, unknown> => {
    const cpuMs = cpu.phaseCpuTotalMs
    if (typeof cpuMs !== 'number') return {}
    const classified = classifyStartupDelay(durationMs, cpuMs)
    if (!classified) return {}
    return { phaseWaitMs: classified.waitMs, delayKind: classified.delayKind }
  }
  const finish = (
    level: keyof Logger,
    message: string,
    outcome: 'completed' | 'cancelled' | 'failed',
    fields?: DiagnosticFields,
    extraFields?: Record<string, unknown>
  ): void => {
    if (terminal) return
    terminal = true
    const finishedAt = readNow()
    const terminalCpuFields = cpuFields(latestPhase ?? 'operation-start')
    const phaseDurationMs = Math.max(0, finishedAt - phaseStartedAt)
    const durationMs = Math.max(0, finishedAt - startedAt)
    const operationDelay =
      typeof terminalCpuFields.cpuTotalMs === 'number'
        ? classifyStartupDelay(durationMs, terminalCpuFields.cpuTotalMs)
        : undefined
    emitSafely(logger, level, message, {
      ...eventFields(fields),
      ...(latestPhase === undefined ? {} : { phase: latestPhase }),
      outcome,
      durationMs,
      ...(Object.keys(terminalCpuFields).length === 0 ? {} : { phaseDurationMs }),
      ...terminalCpuFields,
      ...delayFields(phaseDurationMs, terminalCpuFields),
      ...(operationDelay
        ? { waitMs: operationDelay.waitMs, operationDelayKind: operationDelay.delayKind }
        : {}),
      ...extraFields
    })
  }

  emitSafely(logger, 'info', 'operation started', {
    ...baseFields,
    operation,
    operationId,
    outcome: 'started'
  })

  return {
    phase: (name, fields) => {
      if (terminal) return
      const phaseAt = readNow()
      const cpuIntervalPhase = latestPhase ?? 'operation-start'
      latestPhase = name
      const phaseDurationMs = Math.max(0, phaseAt - phaseStartedAt)
      const cpu = cpuFields(cpuIntervalPhase)
      emitSafely(logger, 'info', 'operation phase', {
        ...eventFields(fields),
        phase: name,
        elapsedMs: Math.max(0, phaseAt - startedAt),
        phaseDurationMs,
        ...cpu,
        ...delayFields(phaseDurationMs, cpu)
      })
      phaseStartedAt = phaseAt
    },
    complete: (fields) => finish('info', 'operation completed', 'completed', fields),
    cancel: (fields) => finish('warn', 'operation cancelled', 'cancelled', fields),
    fail: (error, fields) =>
      finish('error', 'operation failed', 'failed', fields, diagnosticErrorFields(error))
  }
}
