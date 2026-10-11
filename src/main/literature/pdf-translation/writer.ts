import { PdfTranslationWriter as Writer } from '@aipoch/pdf-translation/writer'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
const log = createLogger('pdf-translation-pdf')
export class PdfTranslationWriter extends Writer {
  constructor(entry?: () => string) {
    super(entry, {
      debug: (m, f) => log.debug(m, f),
      info: (m, f) => log.info(m, f),
      warn: (m, f) => log.warn(m, f),
      errorFields: diagnosticErrorFields
    })
  }
}
