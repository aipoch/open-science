import type {
  BackgroundResultDelivery,
  ProjectBackgroundActivityChangedEvent
} from '../../shared/background-result-delivery'
import type { JobSummary } from '../../shared/compute'
import { createAcpRuntime } from '../acp/runtime-composition'
import {
  shouldPersistSessionAgentConfiguration,
  toSessionAgentConfiguration,
  type SessionAgentTargetResolver
} from '../acp/session-agent-target'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import {
  buildAgentResultContinuationPrompt,
  hasSavedAgentResultContinuation
} from '../background-result-delivery/continuation'
import { NotebookRunResultDeliveryAdapter } from '../background-result-delivery/notebook-adapter'
import { BackgroundResultDeliveryOwner } from '../background-result-delivery/owner'
import { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'
import {
  resolveBackgroundResultSources,
  type ResolvedBackgroundResultSource
} from '../background-result-delivery/source-resolver'
import { toJobSummary } from '../compute/ipc'
import { createNotebookApplicationModule } from '../notebook/application'
import { getProjectDbClient } from '../projects/prisma-client'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'

export async function composeBackgroundResults({
  applicationEvents,
  resolveSessionAgentTarget,
  runtimeRef,
  getSessionRepository,
  getSessionPersistenceCoordinator,
  getNotebookCommands,
  getJobRepository,
  getHostRepository,
  modules
}: {
  applicationEvents: ApplicationEvents
  resolveSessionAgentTarget: SessionAgentTargetResolver
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  getSessionRepository: () => ReturnType<typeof createDefaultSessionRepository>
  getSessionPersistenceCoordinator: () => Pick<
    SessionPersistenceCommands,
    'loadSessionForContinuation' | 'saveSession' | 'sessionProjectId'
  >
  getNotebookCommands: () => ReturnType<
    typeof createNotebookApplicationModule
  >['capability']['commands']
  getJobRepository: () => import('../compute/job-repository').ComputeJobRepository
  getHostRepository: () => import('../compute/repository').ComputeHostRepository
  modules: ApplicationModuleBuilder
}): Promise<{
  backgroundResultDeliveryRepository: BackgroundResultDeliveryRepository
  markNotebookResultAuthorityReady: () => void
  markComputeResultAuthorityReady: () => void
  resolveDeliverySources: (
    deliveries: readonly BackgroundResultDelivery[]
  ) => Promise<ResolvedBackgroundResultSource[]>
  backgroundResultDelivery: BackgroundResultDeliveryOwner
  computeJobResultDelivery: ComputeJobResultDeliveryAdapter
  notebookRunResultDelivery: NotebookRunResultDeliveryAdapter
}> {
  const backgroundResultDeliveryRepository = new BackgroundResultDeliveryRepository(() =>
    getProjectDbClient(resolveConfigRoot())
  )
  let markNotebookResultAuthorityReady!: () => void
  let markComputeResultAuthorityReady!: () => void
  const notebookResultAuthorityReady = new Promise<void>((resolve) => {
    markNotebookResultAuthorityReady = resolve
  })
  const computeResultAuthorityReady = new Promise<void>((resolve) => {
    markComputeResultAuthorityReady = resolve
  })
  const resolveDeliverySources = (
    deliveries: readonly BackgroundResultDelivery[]
  ): Promise<ResolvedBackgroundResultSource[]> =>
    resolveBackgroundResultSources(deliveries, {
      loadNotebookRuns: async (group) => {
        const state = await getNotebookCommands().state({
          projectId: group.projectId,
          sessionId: group.sessionId,
          workspaceCwd: '',
          runIds: group.sources.map(({ sourceId }) => sourceId)
        })
        return state.runs
      },
      loadComputeJobs: async (sources) =>
        new Map(
          (
            await Promise.all(
              sources.map(async ({ sourceId }) => {
                const job = await getJobRepository().get(sourceId)
                if (!job) return undefined
                const host = await getHostRepository()
                  .get(job.provider_id)
                  .catch(() => null)
                return [
                  sourceId,
                  await toJobSummary(job, host?.displayName ?? job.provider_id, resolveDataRoot())
                ] as const
              })
            )
          ).filter((entry): entry is readonly [string, JobSummary] => entry !== undefined)
        )
    })
  const backgroundResultDelivery: BackgroundResultDeliveryOwner = await modules.add(
    {
      repository: backgroundResultDeliveryRepository,
      resolveSources: resolveDeliverySources,
      waitForAuthoritiesReady: () =>
        Promise.all([notebookResultAuthorityReady, computeResultAuthorityReady]).then(
          () => undefined
        ),
      loadSessionCatalog: async () => {
        const catalog = await getSessionRepository().loadAllWithDiagnostics({ mode: 'read-only' })
        return {
          complete: catalog.isComplete,
          sessions: catalog.result.sessions.map(({ projectId, id }) => ({
            projectId,
            sessionId: id
          }))
        }
      },
      sendContinuation: (request: {
        sessionId: string
        text: string
        deliveryIds: readonly string[]
        continuationMessageId: string
      }) => {
        let settleAdmitted!: () => void
        let rejectAdmission!: (error: unknown) => void
        let admissionSettled = false
        const admitted = new Promise<void>((resolve, reject) => {
          settleAdmitted = () => {
            if (admissionSettled) return
            admissionSettled = true
            resolve()
          }
          rejectAdmission = (error) => {
            if (admissionSettled) return
            admissionSettled = true
            reject(error)
          }
        })
        const result = (async () => {
          try {
            const runtime = runtimeRef.current
            if (!runtime) throw new Error('Agent runtime is unavailable for result delivery.')
            const projectId = await getSessionPersistenceCoordinator().sessionProjectId(
              request.sessionId
            )
            if (!projectId) throw new Error('Background result delivery Session is unavailable.')
            let session = await getSessionPersistenceCoordinator().loadSessionForContinuation(
              projectId,
              request.sessionId
            )
            const agentTarget = await resolveSessionAgentTarget(session)
            if (
              agentTarget &&
              shouldPersistSessionAgentConfiguration(session.agentConfiguration, agentTarget)
            ) {
              session = await getSessionPersistenceCoordinator().saveSession({
                ...session,
                agentConfiguration: toSessionAgentConfiguration(agentTarget)
              })
            }
            if (!runtime.hasLiveSession(session.projectId, session.id) || agentTarget) {
              await runtime.resumeSession({
                sessionId: session.id,
                cwd: session.cwd,
                projectId: session.projectId,
                ...(session.permissionProfile
                  ? { permissionProfile: session.permissionProfile }
                  : {}),
                memoryEnabled: session.memoryEnabled !== false,
                ...(session.agentFrameworkId
                  ? { previousFrameworkId: session.agentFrameworkId }
                  : {}),
                ...(session.agentBackendId ? { previousBackendId: session.agentBackendId } : {}),
                ...(session.specialistId ? { specialistId: session.specialistId } : {}),
                ...(session.specialistBindingPending === true
                  ? { specialistBindingPending: true }
                  : {}),
                ...(session.providerSessionId
                  ? { providerSessionId: session.providerSessionId }
                  : {}),
                ...(session.providerContinuityToken
                  ? { providerContinuityToken: session.providerContinuityToken }
                  : {}),
                ...(agentTarget ? { agentTarget } : {})
              })
            }
            const response = await runtime.sendApplicationPrompt(
              buildAgentResultContinuationPrompt(session, {
                sessionId: request.sessionId,
                text: request.text,
                continuationMessageId: request.continuationMessageId
              }),
              {
                kind: 'application',
                feature: 'background-results',
                purpose: 'agent-result-delivery',
                deliveryKey: `agent-result-delivery:${request.continuationMessageId}`,
                deliveryIds: [...request.deliveryIds]
              },
              undefined,
              (prompt) => {
                void prompt.then(settleAdmitted, rejectAdmission)
                setImmediate(settleAdmitted)
              }
            )
            settleAdmitted()
            return {
              stopReason: response.stopReason,
              continuationMessageId: request.continuationMessageId
            }
          } catch (error) {
            rejectAdmission(error)
            throw error
          }
        })()
        return { admitted, result }
      },
      isContinuationSaved: async (request: {
        sessionId: string
        continuationMessageId: string
        deliveryIds: readonly string[]
      }) => {
        const projectId = await getSessionPersistenceCoordinator().sessionProjectId(
          request.sessionId
        )
        if (!projectId) return false
        const saved = await getSessionPersistenceCoordinator().loadSessionForContinuation(
          projectId,
          request.sessionId
        )
        const messages = [...(saved.conversationGraph?.messages ?? []), ...saved.messages]
        return hasSavedAgentResultContinuation(messages, request)
      },
      canStartSessionTurn: (sessionId: string) => {
        const runtime = runtimeRef.current
        return runtime ? !runtime.getState().promptInFlightSessionIds.includes(sessionId) : false
      },
      onChanged: (event: ProjectBackgroundActivityChangedEvent) =>
        applicationEvents.publish('background-result-delivery:changed', event)
    },
    (options) => {
      const owner = new BackgroundResultDeliveryOwner(options)
      return {
        name: 'background-result-delivery',
        capability: owner,
        dispose: () => owner.dispose()
      }
    }
  )
  const computeJobResultDelivery = new ComputeJobResultDeliveryAdapter({
    register: (source) => backgroundResultDelivery.register(source),
    enqueue: (source) => backgroundResultDelivery.enqueue(source),
    acknowledgeObserved: (source) => backgroundResultDelivery.acknowledgeObserved(source),
    listWaiting: () => backgroundResultDeliveryRepository.listWaiting('compute-job'),
    hasDeliveryPath: (sourceKind, sourceId) =>
      backgroundResultDeliveryRepository.hasDeliveryPath(sourceKind, sourceId)
  })
  const notebookRunResultDelivery = new NotebookRunResultDeliveryAdapter({
    listWaiting: () => backgroundResultDeliveryRepository.listWaiting('local-run'),
    enqueue: (source) => backgroundResultDelivery.enqueue(source)
  })
  return {
    backgroundResultDeliveryRepository,
    markNotebookResultAuthorityReady,
    markComputeResultAuthorityReady,
    resolveDeliverySources,
    backgroundResultDelivery,
    computeJobResultDelivery,
    notebookRunResultDelivery
  }
}
