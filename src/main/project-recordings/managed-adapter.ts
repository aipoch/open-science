import { PROJECT_RECORDING_DATA_FILENAME } from '../../shared/project-recording-data'
import type {
  ManagedProjectRecordingRegistration,
  ManagedProjectRecordingResult
} from '../notebook/managed-execution-service'
import { readObservationProjectExport } from '../run-observation/project-export-reader'
import { startProjectRecording } from './recorder'

/** Bind only already declared outputs to the independent recorder. No viewer or Notebook read. */
export function startManagedProjectRecording(
  input: ManagedProjectRecordingRegistration,
  assertCurrent: () => void,
  read: typeof readObservationProjectExport = readObservationProjectExport
):
  | {
      close(reason?: 'finished' | 'stopped' | 'interrupted'): Promise<ManagedProjectRecordingResult>
    }
  | undefined {
  const images = input.outputs.filter((output) => /\.(png|jpe?g|webp)$/iu.test(output.filename))
  const declarations = input.outputs.filter(
    (output) => output.filename === PROJECT_RECORDING_DATA_FILENAME
  )
  if (!images.length && !declarations.length) return undefined
  if (declarations.length > 1) throw new Error('Ambiguous project recording declaration.')
  const source = { ...input.target }
  const recorder = startProjectRecording({
    recordingId: input.target.executionInvocationId,
    source,
    sources: images.map((output, index) => ({
      key: 'declared-image-' + index,
      kind: 'project-export' as const,
      read: (signal) =>
        read({
          authority: input.outputAuthority,
          scope: source,
          path: output.path,
          signal
        })
    })),
    declarations: declarations.map((output) => ({
      key: PROJECT_RECORDING_DATA_FILENAME,
      read: async (signal) =>
        (
          await read({
            authority: input.outputAuthority,
            scope: source,
            path: output.path,
            signal
          })
        ).bytes
    })),
    save: input.saveAuxiliaryOutput,
    assertCurrent,
    signal: input.signal
  })
  let completion: Promise<ManagedProjectRecordingResult> | undefined
  return {
    close(reason = 'finished') {
      completion ??= (async () => {
        // One last read while the prepared output capability still exists; finish itself never
        // acquires a fresh capability or reads a file after the caller has closed the recording.
        await recorder.sample()
        const result = await recorder.finish(input.signal.aborted ? 'interrupted' : reason)
        return {
          status: result.status,
          ...(result.status === 'saved'
            ? { artifactId: result.artifact.artifactId, versionId: result.artifact.versionId }
            : {}),
          warnings: [...result.warnings]
        }
      })()
      return completion
    }
  }
}
