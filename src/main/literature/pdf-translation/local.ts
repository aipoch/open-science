import { QWEN3_LOCAL_TEXT_GENERATION_MODEL } from '@aipoch/providers'
import {
  createLocalTextRuntime,
  LocalModelError,
  type LocalTextModel
} from '@aipoch/providers/local'
import type { PdfTranslationLocalRuntime, PdfTranslationLocalTarget } from '@aipoch/pdf-translation'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { LOCAL_MODEL_NOT_INSTALLED } from '../../../shared/local-models'
import { PdfTranslationError } from '@aipoch/pdf-translation/contracts'
import type { LocalModelOwner, LocalModelUse } from '../../local-models/owner'
import { nodeRuntimeEnvironment } from '../../node-process-host'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'

/** Application admission and file leases; the provider runtime owns inference and its queue. */
export const createPdfTranslationLocalRuntime = (
  models: LocalModelOwner
): PdfTranslationLocalRuntime => {
  const runtime = createLocalTextRuntime({
    process: {
      launch(path) {
        const child = spawn(process.execPath, [path], {
          env: { ...process.env, ...nodeRuntimeEnvironment() },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true
        })
        if (process.platform !== 'win32') registerOwnedPosixProcessGroup(child)
        return child
      },
      async terminate(child) {
        const result = await terminateProcessTree(child, 'SIGKILL')
        if (!result.reaped) throw new Error('Local translation worker termination is unconfirmed.')
      }
    }
  })
  const targets = new Map<
    PdfTranslationLocalTarget,
    { use: LocalModelUse; model: LocalTextModel }
  >()
  let closed = false
  return {
    async acquireTarget() {
      if (closed) throw new Error('Local translation runtime is closed.')
      const use = await models.acquireUse().catch((error: unknown) => {
        if (error instanceof Error && error.message === LOCAL_MODEL_NOT_INSTALLED)
          throw new PdfTranslationError(
            'unsupported-model',
            'Install the local translation model first.'
          )
        throw error
      })
      try {
        if (closed) throw new Error('Local translation runtime is closed.')
        const model = runtime.createModel({ directory: dirname(use.assets[0].path) })
        const target = Object.freeze({
          modelId: model.modelId,
          revision: `${use.revision}:${QWEN3_LOCAL_TEXT_GENERATION_MODEL.runtime}`
        })
        targets.set(target, { use, model })
        return target
      } catch (error) {
        use.release()
        throw error
      }
    },
    async run(request) {
      const entry = targets.get(request.target)
      if (closed || !entry) throw new Error('Local translation target is no longer available.')
      try {
        return await entry.model.generate(request)
      } catch (error) {
        if (error instanceof LocalModelError && error.code === 'timeout')
          throw new PdfTranslationError('timeout', 'Local translation timed out.')
        throw error
      }
    },
    async release(target) {
      const entry = targets.get(target)
      if (!entry) return
      await entry.model.dispose()
      if (targets.get(target) === entry) {
        targets.delete(target)
        entry.use.release()
      }
    },
    async shutdown() {
      closed = true
      await runtime.dispose()
      for (const { use } of targets.values()) use.release()
      targets.clear()
    }
  }
}
