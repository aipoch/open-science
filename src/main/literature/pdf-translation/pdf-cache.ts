import { PdfTranslationPdfCache as Cache } from '@aipoch/pdf-translation/storage'
import { createLogger } from '@aipoch/diagnostics/node'
import { withDataRootWrite, runDataRootStartupRecovery } from '../../storage/migration-state'
const log = createLogger('pdf-translation-pdf-cache')
export class PdfTranslationPdfCache extends Cache {
  constructor(options: ConstructorParameters<typeof Cache>[0]) {
    super({
      get root() {
        return options.root
      },
      get revision() {
        return options.revision
      },
      get owner() {
        return options.owner
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
}
