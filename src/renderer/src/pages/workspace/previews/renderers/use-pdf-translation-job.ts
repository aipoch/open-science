import { pdfTranslationBatchSourceIndices } from '../../../../../../shared/pdf-translation-batching'
import {
  providerErrorDetails,
  providerTextGenerationFailure,
  type ProviderTextGenerationFailure
} from '../../../../../../shared/provider-text-generation-failure'
import {
  reconcilePdfTranslationCheckpoint,
  pdfTranslationSourceIndices
} from '../../../../../../shared/pdf-translation-recovery'
import type {
  PdfTranslationCheckpoint,
  PdfTranslationGlossary,
  PdfTranslationBlockFailure,
  PdfTranslationLayoutFailure,
  PdfTranslationApiModel,
  PdfTranslationAgentModel,
  PdfTranslationCheckpointReference
} from '../../../../../../shared/pdf-translation'
import {
  PdfTranslationError,
  pdfTranslationGlossarySchema,
  isPdfTranslationFailureRetryable,
  pdfTranslationAgentModelSchema,
  pdfTranslationFailure,
  type PdfTranslationFailure,
  type PdfTranslationModel
} from '../../../../../../shared/pdf-translation'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { PdfTranslationResults, PdfTranslationSource } from './pdf-translation'
import type { PdfDocumentSource } from '../../../../../../shared/pdf-bookmarks'

export type PdfTranslationTarget = Readonly<{
  id: string
  label: string
  mode: 'local' | 'agent' | 'api'
}>
export type PdfTranslationOptions = Readonly<{
  targetId: string
  apiModel?: PdfTranslationApiModel
  agentModel?: PdfTranslationAgentModel
  language: string
  glossary: PdfTranslationGlossary
  concurrency?: 1 | 2 | 4
  attachmentVersionId?: string
  documentSource?: PdfDocumentSource
  expectedTargetKey?: string
  checkpoint?: PdfTranslationCheckpointReference
}>
// The application supplies real capabilities. No implicit model, conversation or provider fallback.
export type PdfTranslationExecutor = Readonly<{
  batchShortSources?: boolean
  begin?: (
    source: PdfTranslationSource,
    options: PdfTranslationOptions,
    signal: AbortSignal
  ) => Promise<void | {
    model?: PdfTranslationModel
    checkpoint?: PdfTranslationCheckpointReference
  }>
  end?: (signal: AbortSignal) => Promise<void>
  targets: readonly PdfTranslationTarget[]
  translate: (
    request: Readonly<{
      target: PdfTranslationTarget
      language: string
      glossary: PdfTranslationGlossary
      sourceIndex: number
      replaceExisting?: boolean
      source: string
      signal: AbortSignal
    }>
  ) => Promise<string>
  skip?: (
    request: Readonly<{
      target: PdfTranslationTarget
      language: string
      glossary: PdfTranslationGlossary
      sourceIndex: number
      source: string
      signal: AbortSignal
    }>
  ) => Promise<void>
}>
export type PdfTranslationJob = Readonly<{
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error'
  retryUnitId?: string
  /** The failed request eligible for explicit skip, distinct from a single-unit retry. */
  failedUnitId?: string
  done: number
  total: number
  results?: PdfTranslationResults
  options?: PdfTranslationOptions
  model?: PdfTranslationModel
  failure?: PdfTranslationFailure
  errorDetails?: string
  providerFailure?: ProviderTextGenerationFailure
}>
const idle: PdfTranslationJob = { status: 'idle', done: 0, total: 0 }

async function translateWithRetry(
  executor: PdfTranslationExecutor,
  request: Parameters<PdfTranslationExecutor['translate']>[0],
  onFailure: (error: unknown) => void
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const translated = await executor.translate(request)
      if (typeof translated !== 'string' || !translated.trim() || translated.length > 100000)
        throw new PdfTranslationError('incomplete-output', 'Invalid translation')
      return translated
    } catch (error) {
      if (!request.signal.aborted && pdfTranslationFailure(error) !== 'cancelled') onFailure(error)
      if (
        attempt === 0 &&
        (pdfTranslationFailure(error) === 'incomplete-output' ||
          providerTextGenerationFailure(error)?.kind === 'network')
      ) {
        request.signal.throwIfAborted()
        continue
      }
      throw error
    }
  }
  throw new PdfTranslationError('incomplete-output', 'Invalid translation')
}

export function usePdfTranslationJob(
  source: PdfTranslationSource | undefined,
  executor: PdfTranslationExecutor | undefined,
  checkpoint?: PdfTranslationCheckpoint | null
): {
  state: PdfTranslationJob
  start: (options: PdfTranslationOptions) => void
  restart: (options: PdfTranslationOptions) => void
  retryUnit: (unitId: string) => void
  skipUnit: (unitId: string) => void
  cancel: () => void
  reset: () => void
} {
  const active = useRef<AbortController | undefined>(undefined)
  const [stored, setStored] = useState<{
    source: PdfTranslationSource
    executor: PdfTranslationExecutor
    state: PdfTranslationJob
  }>()
  const [restored, setRestored] = useState<{
    checkpoint: typeof checkpoint
    source: typeof source
    executor: typeof executor
  }>()
  const current = stored?.source === source && stored?.executor === executor ? stored : undefined
  if (stored && !current) setStored(undefined)
  // A reconnect replaces the PDF/source while retaining the saved checkpoint object.
  // Consume recovery per context, so an explicit reset within that context stays empty.
  if (
    checkpoint !== restored?.checkpoint ||
    source !== restored?.source ||
    executor !== restored?.executor
  ) {
    setRestored({ checkpoint, source, executor })
    if (
      checkpoint &&
      source &&
      executor &&
      (!current || checkpoint.key !== restored?.checkpoint?.key)
    ) {
      const value = restorePdfTranslationJob(source, checkpoint)
      setStored(value ? { source, executor, state: value } : undefined)
    }
  }
  const state = current?.state ?? idle
  useLayoutEffect(() => {
    // A newly selected edition owns its run. Suppressing recovery for a fresh
    // translation must not abort the controller started by that same action.
    if (checkpoint?.key) {
      active.current?.abort()
      active.current = undefined
    }
  }, [checkpoint?.key])
  useLayoutEffect(
    () => () => {
      active.current?.abort()
      active.current = undefined
    },
    [source, executor]
  )
  const publish = (value: PdfTranslationJob): void => {
    if (source && executor) setStored({ source, executor, state: value })
  }
  const cancel = useCallback((): void => {
    active.current?.abort()
    active.current = undefined
    setStored((current) =>
      current?.source === source &&
      current?.executor === executor &&
      current?.state.status === 'running'
        ? { ...current, state: { ...current.state, status: 'cancelled' } }
        : current
    )
  }, [source, executor])
  const reset = (): void => {
    active.current?.abort()
    active.current = undefined
    setStored(undefined)
  }
  const start = (
    input: PdfTranslationOptions,
    fresh = false,
    retryUnitId?: string,
    skipUnitId?: string
  ): void => {
    if (
      !source ||
      !executor ||
      active.current ||
      (!fresh && !retryUnitId && state.status === 'completed')
    )
      return
    const matches = executor.targets.filter((t) => t.id === input.targetId)
    if (
      matches.length !== 1 ||
      !input.language.trim() ||
      input.language.length > 80 ||
      !pdfTranslationGlossarySchema.safeParse(input.glossary).success ||
      (input.concurrency !== undefined && ![1, 2, 4].includes(input.concurrency))
    )
      return
    const requested = Object.freeze({
        ...input,
        language: input.language.trim(),
        glossary: pdfTranslationGlossarySchema.parse(input.glossary)
      }),
      target = Object.freeze({ ...matches[0] })
    // Retry keeps only validated units for this exact source and pinned options.
    // Ignore incomplete historical state so the user can repair its settings in place.
    const pinnedOptions = !fresh && state.options?.language.trim() ? state.options : undefined
    if (pinnedOptions && JSON.stringify(pinnedOptions) !== JSON.stringify(requested)) return
    const options = pinnedOptions ?? requested
    const units = source.units.filter((unit) => !unit.sourceOnly)
    if (!units.length) return
    const accepted = [...(!fresh ? (state.results?.units ?? []) : [])],
      controller = new AbortController()
    const unitOrder = new Map(units.map((unit, index) => [unit.id, index]))
    const acceptedIds = new Set(accepted.map((unit) => unit.id))
    const failedIds = new Set(!fresh ? state.results?.failedUnitIds : [])
    const failures = new Map<string, PdfTranslationBlockFailure>(
      !fresh ? Object.entries(state.results?.failures ?? {}) : []
    )
    const isSkipped = (id: string): boolean =>
      failedIds.has(id) && !isPdfTranslationFailureRetryable(failures.get(id))
    const markSkipped = (unitId: string): void => {
      const failure = failures.get(unitId)
      failures.set(unitId, {
        reasonCode: failure?.reasonCode ?? 'skipped',
        pageNumbers: failure?.pageNumbers ?? [
          ...new Set(units[unitOrder.get(unitId)!].fragments.map((fragment) => fragment.pageNumber))
        ],
        attempts: failure?.attempts ?? 0,
        disposition: 'skipped'
      })
      failedIds.add(unitId)
    }
    const layoutFailures = new Map<string, PdfTranslationLayoutFailure>(
      !fresh ? Object.entries(state.results?.layoutFailures ?? {}) : []
    )
    if (
      retryUnitId &&
      ((!acceptedIds.has(retryUnitId) && !failedIds.has(retryUnitId)) ||
        !units.some((unit) => unit.id === retryUnitId))
    )
      return
    if (
      skipUnitId &&
      (!executor.skip ||
        state.status !== 'error' ||
        state.failedUnitId !== skipUnitId ||
        acceptedIds.has(skipUnitId) ||
        !unitOrder.has(skipUnitId))
    )
      return
    let failedUnitId: string | undefined
    let model = fresh ? undefined : state.model
    let results = fresh ? undefined : state.results
    let checkpointContext = fresh ? undefined : state.results?.checkpoint
    active.current = controller
    const progress = (status: PdfTranslationJob['status']): PdfTranslationJob => ({
      status,
      ...(retryUnitId && status !== 'completed' ? { retryUnitId } : {}),
      done: accepted.length,
      total: units.length,
      options,
      ...(model ? { model } : {}),
      ...(results ? { results } : {})
    })
    publish(progress('running'))
    void (async () => {
      let failedInternally = false
      try {
        if (executor.begin) {
          const admission = await executor.begin(source, options, controller.signal)
          controller.signal.throwIfAborted()
          if (active.current !== controller) return
          model = admission?.model ?? model
          const checkpointSource = options.documentSource ?? options.attachmentVersionId
          if (admission?.checkpoint && checkpointSource)
            checkpointContext = { key: admission.checkpoint.key, source: checkpointSource }
          publish(progress('running'))
        }
        if (skipUnitId) {
          const sourceIndex = unitOrder.get(skipUnitId)!
          await executor.skip!({
            target,
            language: options.language,
            glossary: options.glossary,
            sourceIndex,
            source: units[sourceIndex].source,
            signal: controller.signal
          })
          controller.signal.throwIfAborted()
          if (active.current !== controller) return
          markSkipped(skipUnitId)
          results = Object.freeze({
            source,
            ...(checkpointContext ? { checkpoint: checkpointContext } : {}),
            ...(layoutFailures.size
              ? { layoutFailures: Object.freeze(Object.fromEntries(layoutFailures)) }
              : {}),
            units: Object.freeze([...accepted]),
            failedUnitIds: Object.freeze([...failedIds]),
            ...(failures.size ? { failures: Object.freeze(Object.fromEntries(failures)) } : {})
          })
          publish(progress('running'))
        }
        const pending = units.flatMap((unit, sourceIndex) =>
          (retryUnitId ? unit.id !== retryUnitId : acceptedIds.has(unit.id) || isSkipped(unit.id))
            ? []
            : [{ unit, sourceIndex }]
        )
        const groups: (typeof pending)[] = []
        const pendingIndices = new Set(pending.map(({ sourceIndex }) => sourceIndex))
        const sources = units.map(({ source }) => source)
        for (let offset = 0; offset < pending.length;) {
          const size =
            executor.batchShortSources && target.mode !== 'local' && !retryUnitId
              ? Math.max(
                  1,
                  pdfTranslationBatchSourceIndices(
                    sources,
                    pending[offset].sourceIndex,
                    (index) => !pendingIndices.has(index)
                  ).length
                )
              : 1
          groups.push(pending.slice(offset, offset + size))
          offset += size
        }
        let next = 0
        let stopped = false
        const worker = async (): Promise<void> => {
          let group: typeof pending = []
          while (!stopped && (group.length || next < groups.length)) {
            if (!group.length) group = [...groups[next++]]
            const { sourceIndex, unit } = group.shift()!
            controller.signal.throwIfAborted()
            let translated: string
            try {
              translated = await translateWithRetry(
                executor,
                {
                  target,
                  language: options.language,
                  glossary: options.glossary,
                  sourceIndex,
                  ...(retryUnitId && acceptedIds.has(unit.id) ? { replaceExisting: true } : {}),
                  source: unit.source,
                  signal: controller.signal
                },
                (error) => {
                  if (acceptedIds.has(unit.id)) return
                  const code = pdfTranslationFailure(error)
                  if (
                    code !== 'incomplete-output' &&
                    code !== 'timeout' &&
                    !providerTextGenerationFailure(error)
                  )
                    return
                  const diagnostic =
                    error instanceof PdfTranslationError ? error.diagnostic : undefined
                  failures.set(
                    unit.id,
                    diagnostic ?? {
                      disposition: 'retryable',
                      reasonCode:
                        code === 'incomplete-output' || code === 'timeout'
                          ? code
                          : 'provider-failed',
                      attempts: (failures.get(unit.id)?.attempts ?? 0) + 1,
                      pageNumbers: [
                        ...new Set(unit.fragments.map((fragment) => fragment.pageNumber))
                      ]
                    }
                  )
                }
              )
            } catch (error) {
              controller.signal.throwIfAborted()
              if (active.current !== controller) return
              if (
                pdfTranslationFailure(error) !== 'incomplete-output' ||
                acceptedIds.has(unit.id)
              ) {
                // Only paragraph/network failures are skippable. Authentication,
                // model and checkpoint errors must be repaired before continuing.
                if (
                  !acceptedIds.has(unit.id) &&
                  (pdfTranslationFailure(error) === 'timeout' ||
                    ['network', 'unavailable'].includes(
                      providerTextGenerationFailure(error)?.kind ?? ''
                    ))
                )
                  failedUnitId ??= unit.id
                if (failures.size)
                  results = Object.freeze({
                    source,
                    ...(checkpointContext ? { checkpoint: checkpointContext } : {}),
                    ...(layoutFailures.size
                      ? { layoutFailures: Object.freeze(Object.fromEntries(layoutFailures)) }
                      : {}),
                    units: Object.freeze(
                      [...accepted].sort((a, b) => unitOrder.get(a.id)! - unitOrder.get(b.id)!)
                    ),
                    ...(failedIds.size || results?.failedUnitIds
                      ? { failedUnitIds: Object.freeze([...failedIds]) }
                      : {}),
                    ...(failures.size
                      ? { failures: Object.freeze(Object.fromEntries(failures)) }
                      : {})
                  })
                throw error
              }
              // Persist the terminal decision separately from an individual failed attempt.
              // A crash between attempts must leave this paragraph eligible for recovery.
              await executor.skip?.({
                target,
                language: options.language,
                glossary: options.glossary,
                sourceIndex,
                source: unit.source,
                signal: controller.signal
              })
              controller.signal.throwIfAborted()
              if (active.current !== controller) return
              markSkipped(unit.id)
              results = Object.freeze({
                source,
                ...(checkpointContext ? { checkpoint: checkpointContext } : {}),
                ...(layoutFailures.size
                  ? { layoutFailures: Object.freeze(Object.fromEntries(layoutFailures)) }
                  : {}),
                units: Object.freeze(
                  [...accepted].sort((a, b) => unitOrder.get(a.id)! - unitOrder.get(b.id)!)
                ),
                failedUnitIds: Object.freeze([...failedIds]),
                ...(failures.size ? { failures: Object.freeze(Object.fromEntries(failures)) } : {})
              })
              publish(progress('running'))
              continue
            }
            controller.signal.throwIfAborted()
            if (active.current !== controller) return
            const value = Object.freeze({
              id: unit.id,
              translationSource: unit.source,
              translation: translated
            })
            if (acceptedIds.has(unit.id))
              accepted[accepted.findIndex((item) => item.id === unit.id)] = value
            else accepted.push(value)
            acceptedIds.add(unit.id)
            failedIds.delete(unit.id)
            failures.delete(unit.id)
            layoutFailures.delete(unit.id)
            // Status changes must not invalidate the verified PDF or its reading state.
            results = Object.freeze({
              source,
              ...(checkpointContext ? { checkpoint: checkpointContext } : {}),
              ...(layoutFailures.size
                ? { layoutFailures: Object.freeze(Object.fromEntries(layoutFailures)) }
                : {}),
              units: Object.freeze(
                [...accepted].sort((a, b) => unitOrder.get(a.id)! - unitOrder.get(b.id)!)
              ),
              failedUnitIds: Object.freeze([...failedIds]),
              ...(failures.size ? { failures: Object.freeze(Object.fromEntries(failures)) } : {})
            })
            publish(progress('running'))
          }
        }
        const workers = Array.from(
          {
            length: Math.min(
              target.mode === 'local' ? 1 : (options.concurrency ?? 1),
              groups.length
            )
          },
          () =>
            worker().catch((error) => {
              stopped = true
              if (!controller.signal.aborted) {
                failedInternally = true
                controller.abort()
              }
              throw error
            })
        )
        const settled = await Promise.allSettled(workers)
        // A timed-out lane aborts sibling requests. Preserve its actionable
        // error instead of selecting a sibling's generic abort by worker order.
        const failed =
          settled.find(
            (result) =>
              result.status === 'rejected' &&
              (!['unknown', 'cancelled'].includes(pdfTranslationFailure(result.reason)) ||
                providerTextGenerationFailure(result.reason))
          ) ?? settled.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        if (active.current === controller)
          publish({
            ...progress(
              accepted.length + [...failedIds].filter(isSkipped).length === units.length
                ? 'completed'
                : 'cancelled'
            ),
            retryUnitId: undefined
          })
      } catch (error) {
        if ((!controller.signal.aborted || failedInternally) && active.current === controller)
          publish(
            pdfTranslationFailure(error) === 'cancelled'
              ? progress('cancelled')
              : {
                  ...progress('error'),
                  ...(failedUnitId ? { failedUnitId } : {}),
                  failure: pdfTranslationFailure(error),
                  providerFailure: providerTextGenerationFailure(error),
                  errorDetails: providerErrorDetails(error)
                }
          )
      } finally {
        if (active.current === controller) active.current = undefined
        await executor.end?.(controller.signal).catch(() => undefined)
      }
    })()
  }
  return {
    state,
    start: (options) => start(options, false, state.retryUnitId),
    retryUnit: (unitId) => {
      if (state.options) start(state.options, false, unitId)
    },
    skipUnit: (unitId) => {
      if (state.options) start(state.options, false, undefined, unitId)
    },
    restart: (options) => start(options, true),
    cancel,
    reset
  }
}

// Results bind to the saved immutable layout; only legacy records need fresh extraction.
export function restorePdfTranslationJob(
  source: PdfTranslationSource,
  checkpoint: PdfTranslationCheckpoint
): PdfTranslationJob | undefined {
  const units = source.units.filter((unit) => !unit.sourceOnly)
  const reconciled = reconcilePdfTranslationCheckpoint(
    checkpoint,
    source.fingerprint,
    units.map((unit) => unit.source)
  )
  if (!reconciled) return undefined
  checkpoint = reconciled
  const indices = pdfTranslationSourceIndices(checkpoint)
  const pendingFailures = checkpoint.failures?.filter(isPdfTranslationFailureRetryable) ?? []
  const agentSelection =
    checkpoint.model.mode !== 'api' && checkpoint.model.mode !== 'local'
      ? pdfTranslationAgentModelSchema.safeParse({
          frameworkId: checkpoint.model.frameworkId,
          providerId: checkpoint.model.providerId,
          modelId: checkpoint.model.modelId,
          reasoningEffort: checkpoint.model.reasoningEffort
        })
      : undefined
  return {
    status:
      checkpoint.translations.length +
        (checkpoint.failedSourceIndices?.length ?? 0) -
        pendingFailures.length ===
      units.length
        ? 'completed'
        : pendingFailures.length
          ? 'error'
          : 'cancelled',
    ...(pendingFailures.length
      ? {
          failedUnitId: units[pendingFailures[0].sourceIndex].id,
          failure:
            pendingFailures[0].reasonCode === 'timeout'
              ? ('timeout' as const)
              : ('unknown' as const)
        }
      : {}),
    done: checkpoint.translations.length,
    total: units.length,
    model: checkpoint.model,
    options: Object.freeze({
      targetId: checkpoint.model.mode ?? 'agent',
      ...(agentSelection?.success ? { agentModel: agentSelection.data } : {}),
      ...(checkpoint.model.mode === 'api' && checkpoint.model.providerId && checkpoint.model.modelId
        ? {
            apiModel: { providerId: checkpoint.model.providerId, modelId: checkpoint.model.modelId }
          }
        : {}),
      language: checkpoint.language,
      glossary: checkpoint.glossary,
      ...(checkpoint.concurrency !== undefined ? { concurrency: checkpoint.concurrency } : {}),
      ...(checkpoint.attachmentVersionId
        ? { attachmentVersionId: checkpoint.attachmentVersionId }
        : { documentSource: checkpoint.documentSource }),
      expectedTargetKey: checkpoint.targetKey,
      checkpoint: { key: checkpoint.key, revision: checkpoint.revision }
    }),
    ...(checkpoint.translations.length || checkpoint.failedSourceIndices?.length
      ? {
          results: Object.freeze({
            source,
            checkpoint: {
              key: checkpoint.key,
              source: checkpoint.documentSource ?? checkpoint.attachmentVersionId!
            },
            ...(checkpoint.layoutReports?.some((report) => report.failure)
              ? {
                  layoutFailures: Object.freeze(
                    Object.fromEntries(
                      checkpoint.layoutReports.flatMap(({ sourceIndex, failure }) =>
                        failure && units[sourceIndex] ? [[units[sourceIndex].id, failure]] : []
                      )
                    )
                  )
                }
              : {}),
            ...(checkpoint.failures?.length
              ? {
                  failures: Object.freeze(
                    Object.fromEntries(
                      checkpoint.failures.map(({ sourceIndex, ...failure }) => [
                        units[sourceIndex].id,
                        Object.freeze(failure)
                      ])
                    )
                  )
                }
              : {}),
            failedUnitIds: Object.freeze(
              (checkpoint.failedSourceIndices ?? []).map((index) => units[index].id)
            ),
            units: Object.freeze(
              checkpoint.translations.map((translation, index) =>
                Object.freeze({
                  id: units[indices[index]].id,
                  translationSource: units[indices[index]].source,
                  translation
                })
              )
            )
          })
        }
      : {})
  }
}
