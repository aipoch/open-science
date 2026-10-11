import {
  PdfTranslationOwner as Owner,
  type PdfTranslationOptions,
  type TranslationCallerLease
} from '@aipoch/pdf-translation'
import {
  pdfTranslationAgentModelSchema,
  type PdfTranslationAgentModel,
  type PdfTranslationBeginRequest,
  type PdfTranslationBeginResult
} from '../../../shared/pdf-translation'
import { isPdfTranslationApiProvider } from '../../../shared/pdf-translation-models'
import {
  providerErrorDetails,
  providerTextGenerationFailure
} from '../../../shared/provider-text-generation-failure'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { ExplicitAgentBackendTarget } from '../../settings/backend-target'
import {
  ProviderTextGenerationError,
  providerTextGenerationTargetKey,
  type ProviderTextGenerationTarget
} from '../../settings/provider-text-generation'
import { runDataRootStartupRecovery, withDataRootWrite } from '../../storage/migration-state'
const log = createLogger('pdf-translation')
type PackageOptions = PdfTranslationOptions<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
>
type Options = Omit<PackageOptions, 'captureTarget'> & {
  captureTarget: (model?: PdfTranslationAgentModel) => ReturnType<PackageOptions['captureTarget']>
}
export class PdfTranslationOwner extends Owner<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
> {
  override async begin(
    input: PdfTranslationBeginRequest,
    caller: TranslationCallerLease
  ): Promise<PdfTranslationBeginResult> {
    caller.signal.throwIfAborted()
    if (
      input?.agentModel !== undefined &&
      !pdfTranslationAgentModelSchema.safeParse(input.agentModel).success
    )
      throw new Error('Invalid PDF translation source.')
    return super.begin(input, caller)
  }

  constructor(options: Options) {
    super({
      get usage() {
        return options.usage
      },
      get checkpoints() {
        return options.checkpoints
      },
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
}
