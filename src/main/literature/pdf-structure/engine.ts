import {
  createPdfStructureEngine as createEngine,
  createPdfStructureNodeRuntime,
  type PdfStructureEngine
} from '@aipoch/pdf-structure'
import { nodeRuntimeEnvironment } from '../../node-process-host'
import { PDF_TABLE_MODEL_REVISIONS } from '../../local-models/catalog'
import {
  createPosixProcessTreeOwnership,
  trackOwnedPosixProcessTree,
  terminateProcessTree
} from '../../process-tree'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Keep application process supervision and model selection at the host boundary. */
export const createPdfStructureEngine = (): PdfStructureEngine => {
  const runtimes = new WeakMap<
    ChildProcessWithoutNullStreams,
    ReturnType<typeof createPdfStructureNodeRuntime>
  >()
  return createEngine({
    modelRecipe: PDF_TABLE_MODEL_REVISIONS[0],
    runtime: {
      spawn(entry) {
        // Each concurrently running job needs its own marker and IPC acknowledgement state.
        const ownership = createPosixProcessTreeOwnership({
          ...process.env,
          ...nodeRuntimeEnvironment()
        })
        const supervised = createPdfStructureNodeRuntime({
          env: ownership.env,
          detached: process.platform !== 'win32'
        })
        const child = supervised.spawn(entry)
        runtimes.set(child, supervised)
        if (process.platform !== 'win32') trackOwnedPosixProcessTree(child, ownership.token)
        return child
      },
      async stop(child) {
        try {
          const supervised = runtimes.get(child)
          if (!supervised) throw new Error('PDF worker ownership is unavailable.')
          await supervised.stop(child)
          if (process.platform === 'win32') return
          // Retire POSIX tracking even after a cooperative IPC acknowledgement.
        } catch {
          // Missing IPC proof requires the application's stronger process-tree owner.
        }
        const outcome = await terminateProcessTree(child, 'SIGTERM')
        if (!outcome.reaped) throw new Error('PDF worker termination is unconfirmed.')
      }
    }
  })
}
