import { spawn } from 'node:child_process'
import {
  createPdfStructureEngine as createEngine,
  type PdfStructureEngine
} from '@aipoch/pdf-structure'
import { nodeRuntimeEnvironment } from '../../node-process-host'
import { PDF_TABLE_MODEL_REVISIONS } from '../../local-models/catalog'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'

/** Keep application process supervision and model selection at the host boundary. */
export const createPdfStructureEngine = (): PdfStructureEngine =>
  createEngine({
    modelRecipe: PDF_TABLE_MODEL_REVISIONS[0],
    runtime: {
      spawn(entry) {
        const child = spawn(process.execPath, [entry], {
          env: { ...process.env, ...nodeRuntimeEnvironment() },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true
        })
        if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
        return child
      },
      async stop(child) {
        const outcome = await terminateProcessTree(child, 'SIGTERM')
        if (!outcome.reaped) throw new Error('PDF worker termination is unconfirmed.')
      }
    }
  })
