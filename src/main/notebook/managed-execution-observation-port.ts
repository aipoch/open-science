import { z } from 'zod'
import type { ManagedObservationResult } from '../../shared/managed-execution'
import type { SessionOperationContext } from './session-operation-owner'

/** Exact admitted execution identity. This port is supplied by trusted Main composition;
 * neither an execution request nor a package can install an observer. */
export type ManagedObservationTarget = {
  projectId: string
  sessionId: string
  operationId?: string
  executionInvocationId?: string
  runId?: string
}

/** Opaque in the execution owner. An adapter retains its own private capture authority and
 * must reject a handle which it did not create for this exact admission. */
export type ManagedObservationHandle = object

type ObservationContext = Pick<
  SessionOperationContext,
  'projectId' | 'sessionId' | 'provenanceContext' | 'saveAuxiliaryOutput'
>
type ObservationMedia = {
  mediaKey: string
  name: string
  mimeType: string
  checksum: string
  sizeBytes: number
  sourceVersionId: string
  stepKeys: string[]
}

/** Optional evidence lifecycle, independent of the experiment's result. Concrete capture,
 * archive serialization, publication receipts and viewers belong to the installed adapter.
 * Adapter capture/publication failures must return an honest failed/unavailable result, without
 * replacing the experiment outcome. Recovery may confirm only original exact write intents. */
export type ManagedExecutionObservationPort = {
  begin(
    target: ManagedObservationTarget,
    context: ObservationContext
  ): Promise<{ result: ManagedObservationResult; handle?: ManagedObservationHandle }>
  publish(input: {
    target: ManagedObservationTarget
    context: ObservationContext
    handle?: ManagedObservationHandle
    media?: readonly ObservationMedia[]
    recovery: boolean
    reservedFilenames?: readonly string[]
  }): Promise<{
    result: ManagedObservationResult
    output?: { filename: string; versionId: string }
    savedInCurrentTurn: boolean
  }>
  confirm(target: ManagedObservationTarget): Promise<ManagedObservationResult | undefined>
  reconcilePublished(scope?: { projectId: string; sessionId: string }): Promise<void>
  drain(handle: ManagedObservationHandle): Promise<void>
}

/** Strict compatibility parsing for existing journals, not a public launch option.
 * This layer does not expose an offline-demo executor or change historical Run purpose. */
export const legacyDemoViewingAdmissionSchema = z
  .object({
    mode: z.enum(['process-lifetime', 'until-stop-or-timeout']),
    timeoutMs: z.number().int().min(1000).max(600_000)
  })
  .strict()
export type LegacyDemoViewingAdmission = z.infer<typeof legacyDemoViewingAdmissionSchema>
