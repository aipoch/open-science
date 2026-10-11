import { fromTranslationSourceId } from '../../../shared/pdf-translation'
import type { PrismaClient } from '@prisma/client'
import { PdfTranslationUsageRecorder as Recorder } from '@aipoch/pdf-translation/storage'
import type { TranslationUsageRepository } from '@aipoch/pdf-translation/storage'
import { withDataRootWrite, runDataRootStartupRecovery } from '../../storage/migration-state'
export class PdfTranslationUsageRecorder extends Recorder {
  constructor(getClient: () => Promise<PrismaClient>) {
    const adapters = new WeakMap<PrismaClient, TranslationUsageRepository>()
    super(
      async () => {
        const client = await getClient()
        let adapter = adapters.get(client)
        if (!adapter) {
          adapter = {
            recoverStarted: () =>
              client.pdfTranslationUsage.updateMany({
                where: { status: 'started' },
                data: { status: 'interrupted' }
              }),
            createAttempt: ({ sourceId, ...data }) => {
              const source = sourceId === undefined ? undefined : fromTranslationSourceId(sourceId)
              return client.pdfTranslationUsage.create({
                data: {
                  ...data,
                  ...(typeof source === 'string' ? { attachmentVersionId: source } : {})
                }
              })
            },
            completeAttempt: (eventId, data) =>
              client.pdfTranslationUsage.updateMany({
                where: { eventId, status: { in: ['started', 'interrupted'] } },
                data
              }),
            hasAttempt: async (eventId) =>
              Boolean(await client.pdfTranslationUsage.findUnique({ where: { eventId } }))
          }
          adapters.set(client, adapter)
        }
        return adapter
      },
      { write: withDataRootWrite, recover: runDataRootStartupRecovery }
    )
  }
}
