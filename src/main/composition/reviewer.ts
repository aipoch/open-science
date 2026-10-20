import { registerReviewerIpcHandlers } from '../desktop-surface-declarations'
import type { ApplicationEvents } from '../application-events'
import type { ApplicationModuleBuilder } from '../application-runtime'
import { BackendShutdownOutcomeError, QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import {
  createReviewerCommandOwner,
  type ReviewerCommandOwner,
  type ReviewerIpcOptions
} from '../reviewer/ipc'
import { createReviewerHostPagedContentResolver } from '../reviewer/paged-preview-host'
import { ReviewerModelRuntimeOwner } from '../reviewer/model-runtime-owner'

type ReviewerRuntimeShutdownOwner = Pick<
  ReviewerModelRuntimeOwner,
  'hasActiveWork' | 'shutdown' | 'shutdownForUpdateGate'
>

type ReviewerCompositionDependencies = Readonly<{
  applicationEvents?: ApplicationEvents
  modelRuntime: ConstructorParameters<typeof ReviewerModelRuntimeOwner>[0]
  options: Omit<ReviewerIpcOptions, 'modelRuntime' | 'pagedContentResolver'>
  previewResources: Parameters<typeof createReviewerHostPagedContentResolver>[0]
  runtimeShutdownOwner: { current: ReviewerRuntimeShutdownOwner | undefined }
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
}>

export const registerReviewerComposition = async (
  modules: ApplicationModuleBuilder,
  {
    modelRuntime,
    applicationEvents,
    options,
    previewResources,
    runtimeShutdownOwner,
    declareElectronAdapter
  }: ReviewerCompositionDependencies
): Promise<ReviewerCommandOwner> => {
  const reviewerModelRuntime = await modules.add(modelRuntime, (options) => {
    const owner = new ReviewerModelRuntimeOwner(options)
    runtimeShutdownOwner.current = owner
    return {
      name: 'reviewer-model-runtime',
      capability: owner,
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
      dispose: async () => {
        try {
          if (!(await owner.shutdown()).reaped) {
            throw new BackendShutdownOutcomeError('degraded')
          }
        } finally {
          if (runtimeShutdownOwner.current === owner) runtimeShutdownOwner.current = undefined
        }
      }
    }
  })
  const reviewerOptions: ReviewerIpcOptions = {
    ...options,
    modelRuntime: reviewerModelRuntime,
    pagedContentResolver: createReviewerHostPagedContentResolver(previewResources)
  }
  const reviewerCommandOwner = createReviewerCommandOwner(reviewerOptions)
  if (applicationEvents)
    await modules.add({}, () => ({
      name: 'reviewer-correction-resume',
      capability: undefined,
      dispose: applicationEvents.subscribe((event) => {
        if (event.channel === 'session:updated')
          void reviewerCommandOwner.onSessionUpdated(event.payload.session)
      })
    }))
  declareElectronAdapter('reviewer', () => {
    registerReviewerIpcHandlers(reviewerOptions, reviewerCommandOwner)
  })
  return reviewerCommandOwner
}

export type { ReviewerRuntimeShutdownOwner }
