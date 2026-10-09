import type {
  ManagedExecutionObservationPort,
  ManagedObservationHandle
} from '../notebook/managed-execution-observation-port'
import type { ManagedRunObservationCoordinator } from './managed-coordinator'
import type { RunObservationRecordingHandle } from './recorder'

/** Main composition keeps capture authority outside the execution owner. Opaque execution
 * handles can only be resolved by the adapter that issued them; packages and callers cannot
 * supply a recorder handle by copying its public fields. */
export function createManagedObservationPort(
  coordinator: Pick<
    ManagedRunObservationCoordinator,
    'begin' | 'publish' | 'confirm' | 'reconcilePublished' | 'drain'
  >
): {
  port: ManagedExecutionObservationPort
  resolveRecording(handle: ManagedObservationHandle): RunObservationRecordingHandle
} {
  const handles = new WeakMap<ManagedObservationHandle, RunObservationRecordingHandle>()
  const resolveRecording = (handle: ManagedObservationHandle): RunObservationRecordingHandle => {
    const recording = handles.get(handle)
    if (!recording) throw new Error('The recording handle was not issued by this observer.')
    return recording
  }
  return {
    resolveRecording,
    port: {
      async begin(target, context) {
        const started = await coordinator.begin(target, context)
        if (!started.handle) return { result: started.result }
        const handle = Object.freeze({})
        handles.set(handle, started.handle)
        return { result: started.result, handle }
      },
      publish(input) {
        return coordinator.publish({
          ...input,
          handle: input.handle ? resolveRecording(input.handle) : undefined
        })
      },
      confirm: (target) => coordinator.confirm(target),
      reconcilePublished: (scope) => coordinator.reconcilePublished(scope),
      drain: (handle) => coordinator.drain(resolveRecording(handle))
    }
  }
}
