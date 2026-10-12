import { z } from 'zod'
import {
  collectManagedOutputsRequestSchema,
  managedCollectionReferenceSchema
} from '../shared/managed-execution'
import type { ManagedExecutionService } from './notebook/managed-execution-service'
import {
  ResearchMaterialUnavailableError,
  researchMaterialUnavailableMessage,
  ResearchMaterialVersionSelectionError,
  RESEARCH_MATERIAL_VERSION_SELECTION_MESSAGE
} from './notebook/research-materials'
import { withDataRootWrite } from './storage/migration-state'
import type { CallerContext } from './caller-context'

export const MANAGED_EXECUTION_EXTERNAL_METHODS = [
  'runtimes',
  'createSession',
  'inspectMaterials',
  'inspectOfflinePlans',
  'executeOfflinePlan',
  'preflight',
  'requestConfiguration',
  'getConfiguration',
  'prepare',
  'execute',
  'getOperation',
  'cancelOperation',
  'waitOperation',
  'getEnvironment',
  'releaseEnvironment',
  'collectOutputs',
  'discardOutputs'
] as const

export type ManagedExecutionExternalMethod = (typeof MANAGED_EXECUTION_EXTERNAL_METHODS)[number]

/** Main-owned adapter. Requests and replies contain public identifiers, never capabilities. */
export type ManagedExecutionExternalPort = {
  /** Optional additive viewing capability; execution dispatch stays on its existing path. */
  observation?: import('./run-observation-external-port').RunObservationExternalPort
  replays?: import('./research-replay/external-port').ResearchReplayExternalPort
  projectRecordings?: import('./browser-recordings/external-port').BrowserRecordingExternalPort
  call(
    method: ManagedExecutionExternalMethod,
    payload: unknown,
    callerContext?: CallerContext
  ): Promise<unknown>
}

export class ManagedExecutionExternalError extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'unsupported_location'
      | 'unavailable'
      | 'invalid_request'
      | 'conflict'
      | 'not_found',
    message: string
  ) {
    super(message)
    this.name = 'ManagedExecutionExternalError'
  }
}

/** Shared authenticated local adapter for the application router and headless clients. */
export function createManagedExecutionExternalPort(dependencies: {
  service: Pick<ManagedExecutionService, ManagedExecutionExternalMethod>
  assertOpen(): void
  withDataRootWrite?: <T>(operation: () => Promise<T>) => Promise<T>
}): ManagedExecutionExternalPort {
  const write = dependencies.withDataRootWrite ?? withDataRootWrite
  return {
    async call(method, payload, caller) {
      if (!caller?.isAuthorizationCurrent())
        throw new ManagedExecutionExternalError('unauthorized', 'Local authentication is required.')
      if (caller.location !== 'local')
        throw new ManagedExecutionExternalError(
          'unsupported_location',
          'Prepared execution is available to local authenticated clients.'
        )
      dependencies.assertOpen()
      if (!(MANAGED_EXECUTION_EXTERNAL_METHODS as readonly string[]).includes(method))
        throw new ManagedExecutionExternalError(
          'invalid_request',
          'Unknown managed execution method.'
        )
      try {
        if (method === 'runtimes')
          z.object({})
            .strict()
            .parse(payload ?? {})
        if (method === 'collectOutputs') payload = collectManagedOutputsRequestSchema.parse(payload)
        if (method === 'discardOutputs') payload = managedCollectionReferenceSchema.parse(payload)
        const result = await write(() =>
          method === 'runtimes'
            ? dependencies.service.runtimes()
            : dependencies.service[method](payload)
        )
        if (result === undefined)
          throw new ManagedExecutionExternalError(
            'not_found',
            'The requested operation was not found.'
          )
        return result
      } catch (error) {
        if (error instanceof ResearchMaterialVersionSelectionError)
          throw new ManagedExecutionExternalError(
            'invalid_request',
            RESEARCH_MATERIAL_VERSION_SELECTION_MESSAGE
          )
        if (error instanceof ResearchMaterialUnavailableError) {
          const message = researchMaterialUnavailableMessage(error.reason)
          if (message) throw new ManagedExecutionExternalError('conflict', message)
        }
        if (error instanceof z.ZodError)
          throw new ManagedExecutionExternalError(
            'invalid_request',
            'The execution request does not match the documented fields.'
          )
        throw error
      }
    }
  }
}
