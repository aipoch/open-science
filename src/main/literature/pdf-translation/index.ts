import { PdfTranslationOwner as Owner, type PdfTranslationOptions } from '@aipoch/pdf-translation'
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
type Options = PdfTranslationOptions<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
>
export class PdfTranslationOwner extends Owner<
  ExplicitAgentBackendTarget & { providerName?: string },
  ProviderTextGenerationTarget & { providerName?: string }
> {
  constructor(options: Options) {
    super({
      get usage() {
        return options.usage
      },
      get checkpoints() {
        return options.checkpoints
      },
      get captureTarget() {
        return options.captureTarget
      },
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
