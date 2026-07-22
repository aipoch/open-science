import type {
  OfficePreviewRuntimeStart,
  OfficePreviewRuntimeState
} from '../../../shared/office-preview'
import type { OfficePreviewRuntimeCleanup, RunOfficePreviewOptions } from './office-preview-runtime'
import { getOfficePreviewRuntimeErrorCode } from './office-preview-runtime'

type OfficePreviewRuntimeBridge = {
  onStart: (listener: (start: OfficePreviewRuntimeStart) => void) => () => void
  reportState: (state: OfficePreviewRuntimeState) => void
}

type ConnectOfficePreviewRuntimeOptions = {
  bridge: OfficePreviewRuntimeBridge
  container: HTMLDivElement
  runPreview: (options: RunOfficePreviewOptions) => Promise<OfficePreviewRuntimeCleanup>
}

const connectOfficePreviewRuntime = (
  options: ConnectOfficePreviewRuntimeOptions
): (() => Promise<void>) => {
  let generation = 0
  let disconnected = false
  let cleanup: OfficePreviewRuntimeCleanup | undefined
  let activeTask: Promise<void> = Promise.resolve()

  // Serialize replacement so two start messages can never own the same DOM or vendor instance.
  const removeStartListener = options.bridge.onStart((start) => {
    const currentGeneration = ++generation
    activeTask = activeTask
      .then(async () => {
        // Keep vendor output transparent while it performs frame-dependent first-paint work.
        options.container.dataset.officePreviewReady = 'false'
        await cleanup?.()
        cleanup = undefined
        options.container.replaceChildren()
        if (disconnected || currentGeneration !== generation) return

        const nextCleanup = await options.runPreview({
          start,
          container: options.container,
          fetchFile: fetch,
          reportState: (state) => {
            if (state.phase === 'ready') options.container.dataset.officePreviewReady = 'true'
            options.bridge.reportState(state)
          }
        })
        if (disconnected || currentGeneration !== generation) {
          await nextCleanup()
          return
        }
        cleanup = nextCleanup
      })
      .catch((error) => {
        if (disconnected || currentGeneration !== generation) return
        options.container.dataset.officePreviewReady = 'false'
        console.error('Failed to render isolated Office preview', error)
        options.bridge.reportState({
          sessionId: start.sessionId,
          phase: 'error',
          error: getOfficePreviewRuntimeErrorCode(error)
        })
      })
  })

  return async () => {
    if (disconnected) return
    disconnected = true
    generation += 1
    removeStartListener()
    await activeTask
    await cleanup?.()
    cleanup = undefined
    options.container.dataset.officePreviewReady = 'false'
    options.container.replaceChildren()
  }
}

export { connectOfficePreviewRuntime }
export type { ConnectOfficePreviewRuntimeOptions, OfficePreviewRuntimeBridge }
