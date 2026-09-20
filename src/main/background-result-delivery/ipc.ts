import type {
  BackgroundResultDeliveryProjectRequest,
  BackgroundResultDeliverySessionRequest,
  ProjectBackgroundActivity,
  SessionBackgroundResultActivity
} from '../../shared/background-result-delivery'
import { ipcMainHandle } from '../ipc-handler-registry'
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

const registerBackgroundResultDeliveryIpcHandlers = (
  repository: BackgroundResultDeliveryIpcRepository,
  options: BackgroundResultDeliveryIpcOptions
): void => {
  ipcMainHandle(
    'background-result-delivery:session-activity',
    async (
      _event,
      request: BackgroundResultDeliverySessionRequest
    ): Promise<SessionBackgroundResultActivity> => {
      const deliveries = await repository.listAwaitingAgent(request.sessionId)
      return {
        active: [],
        awaitingAgent: (await options.resolveSources(deliveries)).map(({ activity }) => activity)
      }
    }
  )
  ipcMainHandle(
    'background-result-delivery:project-activity',
    async (
      _event,
      request: BackgroundResultDeliveryProjectRequest
    ): Promise<ProjectBackgroundActivity> => {
      const deliveries = await repository.listProjectVisible(request.projectId, 201)
      return {
        items: (await options.resolveSources(deliveries.slice(0, 200))).map(
          ({ activity }) => activity
        ),
        truncated: deliveries.length > 200
      }
    }
  )
}

export { registerBackgroundResultDeliveryIpcHandlers }
export type { BackgroundResultDeliveryIpcOptions, BackgroundResultDeliveryIpcRepository }
