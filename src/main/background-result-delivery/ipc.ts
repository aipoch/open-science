import type {
  BackgroundResultDeliveryProjectRequest,
  BackgroundResultDeliverySessionRequest,
  ProjectBackgroundActivity,
  SessionBackgroundResultActivity
} from '../../shared/background-result-delivery'
import { ipcMainHandle } from '../ipc-handler-registry'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import type { BackgroundResultDeliveryRepository } from './repository'
import type { ResolvedBackgroundResultSource } from './source-resolver'

type BackgroundResultDeliveryIpcRepository = Pick<
  BackgroundResultDeliveryRepository,
  'listAwaitingAgent' | 'listProjectVisible'
>

type BackgroundResultDeliveryIpcOptions = Readonly<{
  resolveSources(
    deliveries: Awaited<ReturnType<BackgroundResultDeliveryRepository['listProjectVisible']>>
  ): Promise<ResolvedBackgroundResultSource[]>
}>

export type BackgroundResultActivityOwner = Readonly<{
  sessionActivity(
    request: BackgroundResultDeliverySessionRequest
  ): Promise<SessionBackgroundResultActivity>
  projectActivity(
    request: BackgroundResultDeliveryProjectRequest
  ): Promise<ProjectBackgroundActivity>
}>

export const createBackgroundResultActivityOwner = (
  repository: BackgroundResultDeliveryIpcRepository,
  options: BackgroundResultDeliveryIpcOptions
): BackgroundResultActivityOwner => ({
  sessionActivity: async (request) => {
    if (typeof request?.sessionId !== 'string' || !request.sessionId) {
      throw new ApplicationCommandError(
        'invalid-command-arguments',
        'A Session identity is required.'
      )
    }
    const deliveries = await repository.listAwaitingAgent(request.sessionId)
    return {
      active: [],
      awaitingAgent: (await options.resolveSources(deliveries)).map(({ activity }) => activity)
    }
  },
  projectActivity: async (request) => {
    if (typeof request?.projectId !== 'string' || !request.projectId) {
      throw new ApplicationCommandError(
        'invalid-command-arguments',
        'A project identity is required.'
      )
    }
    const deliveries = await repository.listProjectVisible(request.projectId, 201)
    return {
      items: (await options.resolveSources(deliveries.slice(0, 200))).map(
        ({ activity }) => activity
      ),
      truncated: deliveries.length > 200
    }
  }
})

const registerBackgroundResultDeliveryIpcHandlers = (
  owner: BackgroundResultActivityOwner
): void => {
  ipcMainHandle('background-result-delivery:session-activity', (_event, request) =>
    owner.sessionActivity(request)
  )
  ipcMainHandle('background-result-delivery:project-activity', (_event, request) =>
    owner.projectActivity(request)
  )
}

export { registerBackgroundResultDeliveryIpcHandlers }
export type { BackgroundResultDeliveryIpcOptions, BackgroundResultDeliveryIpcRepository }
