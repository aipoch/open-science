import {
  PdfTranslationOwner as Owner,
  type PdfTranslationOptions,
  type TranslationCallerLease
} from '@aipoch/pdf-translation'
import {
  pdfTranslationAgentModelSchema,
  type PdfTranslationAgentModel,
  type PdfTranslationBeginRequest
} from '../../../shared/pdf-translation'
import { type PdfTranslationBeginResult } from '@aipoch/pdf-translation/contracts'
import { isPdfTranslationApiProvider } from '../../../shared/pdf-translation-models'
import { providerErrorDetails } from '../../../shared/provider-error'
import { providerTextGenerationFailure } from '@aipoch/providers/errors'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { ExplicitAgentBackendTarget } from '../../settings/backend-target'
import {
  providerTextGenerationTargetKey,
  type ProviderTextGenerationTarget
} from './text-generation'
import { ProviderTextGenerationError } from '@aipoch/providers/client'
import { runDataRootStartupRecovery, withDataRootWrite } from '../../storage/migration-state'
const log = createLogger('pdf-translation')
type PackageOptions = PdfTranslationOptions<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
>
import { adaptCheckpointStore, type HostCheckpointStore } from './checkpoint-adapter'
import {
  toPackageBegin,
  toTranslationSourceId,
  fromPackageCheckpoint,
  translationSourceReservationKey,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationSelectEditionRequest,
  type PdfTranslationSaveSnapshotRequest,
  type PdfTranslationRecordLayoutRequest,
  type PdfTranslationCheckpoint
} from '../../../shared/pdf-translation'
type Workflow = Owner<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
>
type Options = Pick<PackageOptions, 'usage' | 'captureApiTarget' | 'apiRunner' | 'localRunner'> & {
  runner: NonNullable<PackageOptions['runner']>
  checkpoints?: HostCheckpointStore
  captureTarget: (
    model?: PdfTranslationAgentModel
  ) => ReturnType<NonNullable<PackageOptions['captureTarget']>>
}
export class PdfTranslationOwner {
  private readonly workflow: Workflow
  async begin(
    input: PdfTranslationBeginRequest,
    caller: TranslationCallerLease
  ): Promise<PdfTranslationBeginResult> {
    caller.signal.throwIfAborted()
    if (
      input?.agentModel !== undefined &&
      !pdfTranslationAgentModelSchema.safeParse(input.agentModel).success
    )
      throw new Error('Invalid PDF translation source.')
    return this.workflow.begin(toPackageBegin(input), caller)
  }

  constructor(options: Options) {
    this.workflow = new Owner({
      sourceKey: translationSourceReservationKey,
      get usage() {
        return options.usage
      },
      checkpoints: options.checkpoints ? adaptCheckpointStore(options.checkpoints) : undefined,
      captureTarget: (model) =>
        options.captureTarget(
          model === undefined ? undefined : pdfTranslationAgentModelSchema.parse(model)
        ),
      get runner() {
        return options.runner
      },
      get captureApiTarget() {
        return options.captureApiTarget
      },
      get apiRunner() {
        return options.apiRunner
      },
      get localRunner() {
        return options.localRunner
      },
      diagnostics: {
        debug: (m: string, f?: Record<string, unknown>) => log.debug(m, f),
        info: (m: string, f?: Record<string, unknown>) => log.info(m, f),
        warn: (m: string, f?: Record<string, unknown>) => log.warn(m, f),
        errorFields: diagnosticErrorFields
      },
      writes: { write: withDataRootWrite, recover: runDataRootStartupRecovery },
      providerErrors: {
        isProviderError: (error: unknown): error is ProviderTextGenerationError =>
          error instanceof ProviderTextGenerationError,
        failure: providerTextGenerationFailure,
        details: providerErrorDetails
      },
      apiTargetKey: providerTextGenerationTargetKey,
      isApiTargetAllowed: (target: ProviderTextGenerationTarget) =>
        isPdfTranslationApiProvider(target.provider)
    })
  }

  translate(...args: Parameters<Workflow['translate']>): ReturnType<Workflow['translate']> {
    return this.workflow.translate(...args)
  }
  skip(...args: Parameters<Workflow['skip']>): ReturnType<Workflow['skip']> {
    return this.workflow.skip(...args)
  }
  close(...args: Parameters<Workflow['close']>): ReturnType<Workflow['close']> {
    return this.workflow.close(...args)
  }
  sweepStaleProfiles(): Promise<void> {
    return this.workflow.sweepStaleProfiles()
  }
  shutdown(): Promise<void> {
    return this.workflow.shutdown()
  }
  saveSnapshot(
    request: PdfTranslationSaveSnapshotRequest,
    caller: TranslationCallerLease
  ): Promise<void> {
    return this.workflow.saveSnapshot(
      { ...request, source: toTranslationSourceId(request.source) },
      caller
    )
  }
  recordLayout(
    request: PdfTranslationRecordLayoutRequest,
    caller: TranslationCallerLease
  ): Promise<void> {
    return this.workflow.recordLayout(
      { ...request, source: toTranslationSourceId(request.source) },
      caller
    )
  }
  async readCheckpoint(
    source: PdfTranslationCheckpointRequest,
    caller: TranslationCallerLease,
    key?: string
  ): Promise<PdfTranslationCheckpoint | null> {
    const result = await this.workflow.readCheckpoint(toTranslationSourceId(source), caller, key)
    return result ? fromPackageCheckpoint(result) : null
  }
  listEditions(
    source: PdfTranslationCheckpointRequest,
    caller: TranslationCallerLease
  ): ReturnType<Workflow['listEditions']> {
    return this.workflow.listEditions(toTranslationSourceId(source), caller)
  }
  async selectEdition(
    request: PdfTranslationSelectEditionRequest,
    caller: TranslationCallerLease
  ): Promise<PdfTranslationCheckpoint> {
    return fromPackageCheckpoint(
      await this.workflow.selectEdition(
        { ...request, source: toTranslationSourceId(request.source) },
        caller
      )
    )
  }
  deleteEdition(
    request: PdfTranslationSelectEditionRequest,
    caller: TranslationCallerLease
  ): Promise<void> {
    return this.workflow.deleteEdition(
      { ...request, source: toTranslationSourceId(request.source) },
      caller
    )
  }
}
