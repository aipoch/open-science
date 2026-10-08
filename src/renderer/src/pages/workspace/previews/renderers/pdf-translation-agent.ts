import { getPdfTranslationLayoutSnapshot } from './pdf-translation-snapshot'
import type {
  PdfTranslationBeginRequest,
  PdfTranslationBeginResult,
  PdfTranslationRunRequest,
  PdfTranslationRunResult,
  PdfTranslationOperationRequest,
  PdfTranslationCheckpointReference
} from '../../../../../../shared/pdf-translation'
import {
  PdfTranslationError,
  pdfTranslationBlockFailureSchema
} from '../../../../../../shared/pdf-translation'
import type {
  PdfTranslationExecutor,
  PdfTranslationTarget,
  PdfTranslationOptions
} from './use-pdf-translation-job'

type PdfTranslationAgentRuntime = Readonly<{
  begin: (request: PdfTranslationBeginRequest) => Promise<PdfTranslationBeginResult>
  translate: (request: PdfTranslationRunRequest) => Promise<PdfTranslationRunResult>
  skip?: (request: PdfTranslationRunRequest) => Promise<void>
  close: (request: PdfTranslationOperationRequest) => Promise<void>
}>
const AGENT_TARGET: PdfTranslationTarget = Object.freeze({
  id: 'agent',
  label: 'Agent',
  mode: 'agent'
})
const API_TARGET: PdfTranslationTarget = Object.freeze({
  id: 'api',
  label: 'Direct API',
  mode: 'api'
})

const LOCAL_TARGET: PdfTranslationTarget = Object.freeze({
  id: 'local',
  label: 'Local model',
  mode: 'local'
})
const supportedTargets = [API_TARGET, AGENT_TARGET, LOCAL_TARGET]

const createPdfTranslationAgentExecutor = (
  runtime: PdfTranslationAgentRuntime,
  label = AGENT_TARGET.label
): PdfTranslationExecutor => {
  const checkpoints = new WeakMap<PdfTranslationOptions, PdfTranslationCheckpointReference>()
  const targets = new WeakMap<PdfTranslationOptions, string>()
  const operations = new WeakMap<
    AbortSignal,
    { id: string; targetId: string; detach: () => void }
  >()
  const end = async (signal: AbortSignal): Promise<void> => {
    const operation = operations.get(signal)
    if (!operation) return
    operations.delete(signal)
    operation.detach()
    await runtime.close({ operationId: operation.id })
  }
  return {
    batchShortSources: true,
    // Keep local inference hidden until its model-management UI is ready.
    targets: [API_TARGET, { ...AGENT_TARGET, label }],
    begin: async (source, options, signal) => {
      signal.throwIfAborted()
      if (
        options.targetId !== 'api' &&
        options.targetId !== 'agent' &&
        options.targetId !== 'local'
      )
        throw new Error('Unsupported PDF translation target.')
      const { operationId, targetKey, model, checkpoint } = await runtime.begin({
        resourceRequestKey: source.resourceRequestKey,
        fingerprint: source.fingerprint,
        targetId: options.targetId,
        ...(options.targetId === API_TARGET.id && options.apiModel
          ? { apiModel: options.apiModel }
          : {}),
        ...(options.targetId === AGENT_TARGET.id && options.agentModel
          ? { agentModel: options.agentModel }
          : {}),
        batchShortSources: options.targetId !== LOCAL_TARGET.id,
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        language: options.language,
        glossary: options.glossary,
        sources: source.units.filter((unit) => !unit.sourceOnly).map((unit) => unit.source),
        ...(getPdfTranslationLayoutSnapshot(source)
          ? { layoutSnapshot: getPdfTranslationLayoutSnapshot(source) }
          : {}),
        sourceLocations: source.units
          .filter((unit) => !unit.sourceOnly)
          .map((unit) => ({
            pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
            fragmentCount: unit.fragments.length
          })),
        ...(options.attachmentVersionId
          ? { attachmentVersionId: options.attachmentVersionId }
          : {}),
        ...(options.documentSource ? { documentSource: options.documentSource } : {}),
        ...(checkpoints.has(options) || options.checkpoint
          ? { checkpoint: checkpoints.get(options) ?? options.checkpoint }
          : {}),
        ...(targets.has(options) || options.expectedTargetKey
          ? { expectedTargetKey: targets.get(options) ?? options.expectedTargetKey }
          : {})
      })
      const abort = (): void => {
        void end(signal).catch(() => undefined)
      }
      operations.set(signal, {
        id: operationId,
        targetId: options.targetId,
        detach: () => signal.removeEventListener('abort', abort)
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        await end(signal)
        signal.throwIfAborted()
      }
      // A cancelled admission may arrive after a newer retry has pinned its model.
      targets.set(options, targetKey)
      if (checkpoint) checkpoints.set(options, checkpoint)
      return { model, ...(checkpoint ? { checkpoint } : {}) }
    },
    translate: async ({ target, sourceIndex, source, signal, replaceExisting }) => {
      signal.throwIfAborted()
      if (!supportedTargets.some((entry) => entry.id === target.id && entry.mode === target.mode))
        throw new Error('Unsupported PDF translation target.')
      const operation = operations.get(signal)
      if (!operation || operation.targetId !== target.id)
        throw new Error('PDF translation is not prepared.')
      const result = await runtime.translate({
        operationId: operation.id,
        sourceIndex,
        source,
        ...(replaceExisting ? { replaceExisting } : {})
      })
      signal.throwIfAborted()
      if (typeof result !== 'string') {
        if (result.failure === 'cancelled')
          throw new PdfTranslationError('cancelled', result.message)
        throw new PdfTranslationError(
          'incomplete-output',
          result.message.replace(/^\[pdf-translation:incomplete-output\]\s*/, ''),
          result.diagnostic ? pdfTranslationBlockFailureSchema.parse(result.diagnostic) : undefined
        )
      }
      return result
    },
    skip: runtime.skip
      ? async ({ target, sourceIndex, source, signal }) => {
          signal.throwIfAborted()
          if (
            !supportedTargets.some((entry) => entry.id === target.id && entry.mode === target.mode)
          )
            throw new Error('Unsupported PDF translation target.')
          const operation = operations.get(signal)
          if (!operation || operation.targetId !== target.id)
            throw new Error('PDF translation is not prepared.')
          await runtime.skip!({ operationId: operation.id, sourceIndex, source })
          signal.throwIfAborted()
        }
      : undefined,
    end
  }
}
export { AGENT_TARGET, API_TARGET, LOCAL_TARGET, createPdfTranslationAgentExecutor }
export type { PdfTranslationAgentRuntime }
