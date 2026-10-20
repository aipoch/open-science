import { PdfTranslationPdfCache as Cache } from '@aipoch/pdf-translation/storage'
import { createLogger } from '@aipoch/diagnostics/node'
import { withDataRootWrite, runDataRootStartupRecovery } from '../../storage/migration-state'
import {
  toTranslationSourceId,
  fromTranslationSourceId,
  pdfTranslationSourceKey,
  toPackageCheckpoint,
  type PdfTranslationPdfRequest,
  type PdfTranslationRecordLayoutRequest
} from '../../../shared/pdf-translation'
import type { PdfTranslationOwner } from './index'
import type { TranslationCallerLease } from '@aipoch/pdf-translation'
type CacheOptions = ConstructorParameters<typeof Cache>[0]
const log = createLogger('pdf-translation-pdf-cache')
export class PdfTranslationPdfCache {
  private readonly cache: Cache
  constructor(
    options: Omit<CacheOptions, 'owner'> & {
      owner: Pick<PdfTranslationOwner, 'readCheckpoint' | 'recordLayout'>
    }
  ) {
    this.cache = new Cache({
      sourceKey: (id) => pdfTranslationSourceKey(fromTranslationSourceId(id)),
      get root() {
        return options.root
      },
      get revision() {
        return options.revision
      },
      owner: {
        recordLayout: (request, caller) =>
          options.owner.recordLayout(
            { ...request, source: fromTranslationSourceId(request.source) },
            caller
          ),
        async readCheckpoint(source, caller, key) {
          const value = await options.owner.readCheckpoint(
            fromTranslationSourceId(source),
            caller,
            key
          )
          return value ? toPackageCheckpoint(value) : null
        }
      },
      get writer() {
        return options.writer
      },
      diagnostics: {
        debug: (m, f) => log.debug(m, f),
        info: (m, f) => log.info(m, f),
        warn: (m, f) => log.warn(m, f),
        errorFields: () => ({})
      },
      writes: { write: withDataRootWrite, recover: runDataRootStartupRecovery }
    })
  }

  generate(
    input: PdfTranslationPdfRequest,
    caller: TranslationCallerLease
  ): ReturnType<Cache['generate']> {
    const { cache, ...request } = input
    return this.cache.generate(
      {
        ...request,
        ...(cache ? { cache: { ...cache, source: toTranslationSourceId(cache.source) } } : {})
      },
      caller
    )
  }
  recordLayout(
    input: PdfTranslationRecordLayoutRequest,
    caller: TranslationCallerLease
  ): Promise<void> {
    return this.cache.recordLayout(
      { ...input, source: toTranslationSourceId(input.source) },
      caller
    )
  }
  cancel(id: string, caller: TranslationCallerLease): void {
    this.cache.cancel(id, caller)
  }
}
