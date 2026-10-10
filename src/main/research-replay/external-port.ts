import { z } from 'zod'
import type { CallerContext } from '../caller-context'
import { ManagedExecutionExternalError } from '../managed-execution-external-port'
import {
  researchReplayTargetSchema,
  researchReplayPositionSchema,
  researchReplayReadSchema,
  type ResearchReplayMethod
} from '../../shared/research-replay'
import type { ResearchReplayHttpHost } from './http-host'
import { ResearchReplayError } from './service'
const viewer = z.object({ viewerId: z.string().uuid() }).strict()
export type ResearchReplayExternalPort = {
  call(method: ResearchReplayMethod, payload: unknown, caller?: CallerContext): Promise<unknown>
}
export function createResearchReplayExternalPort(
  host: ResearchReplayHttpHost,
  assertOpen: () => void
): ResearchReplayExternalPort {
  return {
    async call(method, payload, caller) {
      assertOpen()
      if (!caller?.isAuthorizationCurrent())
        throw new ManagedExecutionExternalError(
          'unauthorized',
          'Current local authorization is required.'
        )
      if (caller.location !== 'local')
        throw new ManagedExecutionExternalError(
          'unsupported_location',
          'Research replay is local to this device.'
        )
      try {
        let result: unknown
        if (method === 'open') {
          const input = z.object({ target: researchReplayTargetSchema }).strict().parse(payload)
          result = await host.open(input.target, caller)
        } else if (method === 'read') {
          const input = viewer.extend({ query: researchReplayReadSchema }).strict().parse(payload)
          result = await host.service.read(input.viewerId, input.query, caller)
        } else if (method === 'select') {
          const input = viewer
            .extend({ position: researchReplayPositionSchema })
            .strict()
            .parse(payload)
          result = await host.service.select(input.viewerId, input.position, caller)
        } else if (method === 'selection') {
          const input = viewer
            .extend({ selectionId: z.string().uuid().optional() })
            .strict()
            .parse(payload)
          result = await host.service.selection(input.viewerId, caller, input.selectionId)
        } else if (method === 'revoke') {
          const input = viewer.parse(payload)
          await host.service.revoke(input.viewerId, caller)
          host.closeViewer(input.viewerId)
          result = { revoked: true }
        } else
          throw new ManagedExecutionExternalError(
            'invalid_request',
            'Unknown research replay method.'
          )
        if (!caller.isAuthorizationCurrent())
          throw new ManagedExecutionExternalError('unauthorized', 'Caller authorization expired.')
        return result
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ManagedExecutionExternalError(
            'invalid_request',
            'Invalid research replay request.'
          )
        if (error instanceof ResearchReplayError)
          throw new ManagedExecutionExternalError(
            error.code === 'unauthorized'
              ? 'unauthorized'
              : error.code === 'invalid'
                ? 'invalid_request'
                : error.code === 'not-found'
                  ? 'not_found'
                  : 'unavailable',
            'Research replay is unavailable.'
          )
        throw error
      }
    }
  }
}
