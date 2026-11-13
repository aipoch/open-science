import {
  createPdfStructureEngine as createEngine,
  createPdfStructureNodeRuntime,
  type PdfStructureEngine
} from '@aipoch/pdf-structure'
import { nodeRuntimeEnvironment } from '../../node-process-host'
import { PDF_TABLE_MODEL_REVISIONS } from '../../local-models/catalog'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'

/** Keep application process supervision and model selection at the host boundary. */
export const createPdfStructureEngine = (): PdfStructureEngine => {
  const supervised = createPdfStructureNodeRuntime({
    env: nodeRuntimeEnvironment(),
    detached: process.platform !== 'win32'
  })
  return createEngine({
    modelRecipe: PDF_TABLE_MODEL_REVISIONS[0],
    runtime: {
      spawn(entry) {
        const child = supervised.spawn(entry)
        if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
        return child
      },
      async stop(child) {
        try {
          await supervised.stop(child)
          return
        } catch {
          // Missing IPC proof requires the application's stronger process-tree owner.
        }
        const outcome = await terminateProcessTree(child, 'SIGTERM')
        if (!outcome.reaped) throw new Error('PDF worker termination is unconfirmed.')
      }
    }
  })
}
